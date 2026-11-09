---
title: "[1편] 내 PaaS에 내 앱 올리기 - 데이터 편"
date: "2026-06-03"
description: "Dailo 이전 1편. 프라이빗 RDS를 SSM 터널로 덤프해 옮기고, 적재 중 만난 MySQL OOM을 performance_schema를 꺼서 해결했습니다."
tags: ["MySQL", "데이터 이전", "OOM"]
series: "KoDeploy"
velog: "https://velog.io/@yun60/1편-내-PaaS에-내-앱-올리기-데이터-편"
thumbnail: "/images/thumbs/my-paas-my-app-data.webp"
---
![](/images/posts/my-paas-my-app-data/01.png)
2부작 중 1편. AWS(S3 + RDS + CloudFront)에 떠 있던 Dailo를 OCI + Cloudflare 기반 자체 PaaS(KoDeploy)로 옮긴 기록 중, 1편은 **데이터 축**(이미지 스토리지 + DB)을 2편은 트래픽/도메인 쪽(origin lock, 커스텀 도메인, apex)을 다룬다

---

## 0. 배경

![](/images/posts/my-paas-my-app-data/02.png)


Dailo는 충주 로컬 축제에 관한 앱으로 총동아리 축제와 연계하여 진행했던 프로젝트이다. 

이걸 OCI + Cloudflare 기반 자체 PaaS(KoDeploy)로 옮기려했다
옮긴 이유는 여러가지 있다

1. **AWS 비용** - 학교 지원금을 받으면서 제대로 된 인프라를 구성해 보고 싶은 욕심이 있었고 이중화, 자동화, stage, prod 구분 등등 하고싶은 거 해보니까 비용이 **달에 25만원씩** 나왔다 (이제 종강으로  지원 끊김)
2. **도그푸딩** - 내가 만든 PaaS를 직접 써보며 사용자 입장에서 무엇이 불편하고 부족한지를 알고자 했다

코드·인프라 설정이야 다시 짜면 되지만, 데이터는 날라가면 끝이기에 신경 쓸 부분 이었고. 그래서 이 글은 인프라 구성보다 **데이터 마이그레이션을 중점**으로 쓰고자 한다

- **이미지 축:** AWS S3 → Cloudflare R2 (rclone)
- **DB 축:** AWS RDS → KoDeploy in-cluster MySQL (mysqldump)

> 다일로는 100명 정도 다운받고 IOS, Android에서 운영중이긴 하지만 추가 개발 및 현재 MOU는 매우 적은 상태인 걸 감안해서 **무중단 보다는 데이터 이전을 중점으로 뒀다**
> 

---

## 1. 프라이빗 RDS를 어떻게 빼냈나

일단 DB 데이터를 뽑아야 한다 위의 아키텍처를 보면 알다시피 EC2, RDS는 모두 Private Subnet에 존재하고 RDS는 WAS만 접속 허용해서 EC2에 있는 SSM을  통해 접근할 수 밖에 없다

 그래서 노트북에서 EC2의 SSM(세션 매니저)을 통해 포트포워딩으로 로컬 3307 → RDS 3306 터널을 뚫었다.

```bash
# 로컬 3307 → RDS 3306 터널 (점프 EC2 경유)
aws ssm start-session --target <EC2_INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<RDS_ENDPOINT>"],"portNumber":["3306"],"localPortNumber":["3307"]}'
```

→ 이렇게 하면 덤프 파일이 **프라이빗 EC2 안이 아니라 노트북에 바로** 생긴다. EC2 안에 덤프를 만들었다가 다시 빼내는 단계가 없어 편하다.

### `localhost`**는 왜 안 돼** (소켓 vs TCP)

터널을 3307에 띄우고 덤프를 떴는데, `-h localhost`는 막히고 `127.0.0.1`는 잘 떠졌다 나의 상식으론 둘 다 현재 호스트를 가리키는 건데 왜 이런 결과가 생겼는지 의문이 들었고 둘의 차이에 대해 알아두는 게 좋을 거 같아 정리해두려한다

```bash
mysqldump -h localhost -P 3307 -u dailo -p ... dailo | gzip > dailo.sql.gz
# ERROR 2002: Can't connect to local MySQL server through socket '/var/lib/mysql/mysql.sock'
mysqldump -h 127.0.0.1 -P 3307 -u dailo -p ... dailo | gzip > dailo.sql.gz
# 성공 — dailo.sql.gz 239K
```

![](/images/posts/my-paas-my-app-data/03.png)


 MySQL 클라이언트가 `localhost`를 만나면 "로컬 서버"로 해석해서 **유닉스 소켓 파일(/var/lib/mysql/mysql.sock)을 보고 127.0.0.1일 경우에는 127.0.0.1로 TCP 연결을 시도한다**

→ MySQL과 일부 DB의 동작으로 일반 프로그램은 보통 둘이 같다 

하지만 내 노트북엔 MySQL서버가 돌아가고 있지 않기에 MySQL의 유닉스 소켓 파일이 존재하지 않아 에러가 난 것이었고 나는 약간 의문이 들었다

#### 왜 굳이 이렇게..?

찾아보니 역시 이유가 있었다

- 유닉스 소켓은 네트워크를 안 거치고 OS 내부에서 주고 받기에 빠르고 오버헤드가 적다
- 127.0.0.1은 TCP로 가는데 TCP 같은 경우 패킷 만들고, 체크섬 계산하고 등등 비교적 단계가 있기에 유닉스 소켓보다 느리다

한 서버 안 연결일 때 유닉스 소켓으로 성능을 올리려는 설계였다. 
내 **문제는 터널·포트포워딩은 TCP 포트에 떠 있기에** localhost(소켓)로는 그 포트를 못 보고, 127.0.0.1(TCP)로 가야 터널을 탄다 그래서 터널 붙일 땐 127.0.0.1이 맞다.

#### 덤프 명령 옵션 간단 설명

```bash
mysqldump -h 127.0.0.1 -P 3307 -u dailo -p \
  --single-transaction --set-gtid-purged=OFF --no-tablespaces \
  --default-character-set=utf8mb4 \
  dailo | gzip > dailo.sql.gz
```

- `-single-transaction` - 정해진 스냅샷 기준 트랜잭션으로 떠서 **테이블 잠금 없이** 일관성 확보 (운영 중 덤프해도 쓰기 안 막음)
- `-no-tablespaces` - 테이블스페이스 메타데이터 제외 → `PROCESS` 권한 없는 제한 유저로도 덤프되며 우리는 데이터가 어느 디스크의 어느 파일에 담겨있는지 보다는 데이터가 중점이기에 필요 없는 것을 덜 수 있다
- `-default-character-set=utf8mb4` — 한글·이모지 안 깨지게
- `dailo` (단일 db명, `-databases` 아님) - 덤프에 `CREATE DATABASE`가 안 들어가 → 대상 DB 이름에 구애 없이 맞춰서 복원하여 호환성이 좀 더 좋음

---

## 2. 적재 중 OOM 발생

덤프를 딴 dailo.sql.gz을 Kodeploy에  기능 내에서 적용하다가 에러가 떠버렸다

![](/images/posts/my-paas-my-app-data/04.png)


해당 기능을 만들고 잘 되는지 테스트를 이미 해봤기에 또 모가 문제냐 생각하고 디버깅을 해봤다

```yaml
$ kubectl describe pod mysql-0
```

![](/images/posts/my-paas-my-app-data/05.png)


하 또 너냐 메모리
가난한 대학생을 항상 괴롭히는 리소스 부족이 또 떠버렸다

과거 스냅샷 테스트 땐 더 가벼운 덤프(30K)로 했고 지금은 239K다. **덤프 크기에 따른 복원 메모리가 한도를 넘긴 것**으로 보였다. 
해당 문제를 해결하려면 MySQL 컨테이너 메모리 제한이 현재 500Mi인데, **제한을 늘리거나 / 쓰고 있는 메모리를 줄여 여유를 확보**해야 한다.

결정 전에, 지금 메모리를 얼마나 쓰는지부터 보고 판단하기로 했다.

![](/images/posts/my-paas-my-app-data/06.png)


500mi 중 438m을 사용하여 빠듯한 상태지만 애초에 **메모리 제한**을 늘릴 생각은 없었다

이유는 현재 노드 자체가 메모리가 제한적이기에 메모리 제한을 높이기에는 부담이 있고, 다른 대안이 있기 때문이다

#### performance_schema 끄기

MySQL에는 `performance_schema`라고 자기 동작을 감시하는 내장 모니터링이 있다 이걸 끄면 된다

perf_schema는 4가지 정도의 일을 하는데

1. 쿼리 성능 분석 (어떤 쿼리가 느린지)
2. 락/데드락 추적
3. 인덱스 튜닝을 위한 테이블/인덱스 사용 통계 
4. 내부 리소스 상태 (커넥/메모리/IO)

사실 나도 이걸 보고 “아니 이렇게 중요한 걸 끄는 게 맞나” 싶었다. 근데 애초에 KoDeploy는 운영 숙련도가 높지 않은, **가벼운 운영을 원하는 바이브코더·대학생**을 타겟으로 한다. 트래픽·쿼리가 많은 사용자엔 애초에 부적합하고, 그러면 **perf_schema가 잡아낼 문제(느린 쿼리·락 경합) 자체가 안 생긴다.** 측정할 부하가 없으니 켜놔도 볼 게 없는 기능인 셈이다

그렇다고 perf_schema가 없으면 영영 못 보는 것들이 아니라 `SHOW PROCESSLIST`, show query log등 가벼운 대체제가 충분하다  그래서 해당 기능이 얼마나 메모리를 잡아 먹는지 확인해보았다

**performance_schema ON**

![](/images/posts/my-paas-my-app-data/07.png)


**performance_schema OFF**

![](/images/posts/my-paas-my-app-data/08.png)


| performance_schema | anon (실제 RSS) |
| --- | --- |
| ON | 438M |
| OFF | 196M |
| **차이** | **~242M** |

performance_schema 하나가 RSS를 **~242MB** 점유한다. 데이터 크기와 무관하게, 기동 시 모니터링용 버퍼를 선점하는 고정 비용이 242MB. 컨테이너 한도는 500Mi(약 524M)으로 **ON이면 438M + import 작업이 겹쳐 한도를 넘을 가능성이 크다**

OFF일 경우 196M이라 import가 겹쳐도 한도 안에 들어오며 보다 더 쾌적하게 사용할 수 있다

즉 정리하면 perf_schema가 **고정으로 메모리를 잠식해 여유를 빠듯하게** 만들어둔 상태에서, **덤프 복원이 그 위에 메모리를 더 쓰며** 한도를 넘은 것이다 30K는 그 빠듯한 여유에 아슬하게 들어왔지만 239K는 안 됐다 한도를 올리는 대신 perf_schema를 꺼서 복원이 쓸 여유를 확보하는 쪽을 택했다.

(추후 어느정도 메모리 까지 복원 가능한지 측정 해봐야할 거 같다)

> **측정 팁:** `memory.current`가 아니라 `memory.stat`의 `anon`을 봐야 한다. current엔 페이지 캐시(`file`)가 껴서 실제보다 부풀어 보인다. 프로세스가 실제로 쓰는 메모리, OOM 판단 기준은 `anon`이다.
> 

### 해결

```yaml
# mysql.yaml.j2 (args)
- --performance-schema=OFF
```

StatefulSet은 생성 시에만 args가 반영돼서, 라이브엔 매니페스트 수정 + 재시작으로 적용했다. (데이터는 PVC에 있어 재시작해도 그대로 - Pod만 바뀜)

> performance_schema는 동적 토글이 안 된다(읽기 전용 시스템 변수). ON/OFF는 기동 시 정해지므로 바꾸려면 재시작이 필요하다. 그래서 "적재 때만 껐다 켜기"도 생각했보았는데 실제 모니터링 기능을 사용할 일도 많이 없고 SQL 한 번 적재시 OFF(재시작) → 적재 → ON(재시작) 매번 재시작이라 OFF로 두는 게 깔끔하다 판단했다 
장기적으로 쿼리 성능 모니터링이 사용자에게 필요하면 메모리 한도를 올려 ON으로 두는 것이 정석이지만, 멀티테넌트 노드 메모리를 고려한 트레이드오프다
> 

![](/images/posts/my-paas-my-app-data/09.png)


복원이 끝났으니 실제로 데이터가 잘 들어갔는지 확인하고 Android 비공개 테스트로 KoDeploy에 올린 Dailo 앱을 띄워봤다(운영과 별개의 앱, 서버)

#### 좌 - Kodeploy, 우 - 다일로

![](/images/posts/my-paas-my-app-data/10.png)


---

## 3. 왜 R2였나 - 이미지 저장소 선택

데이터를 옮겼으니 이제는 S3에 있는 이미지를 올려야 한다 근데 현재 내 PaaS엔 이미지를 올릴 오브젝트 스토리지를 제공하는 기능이 없었기에 만들었고 선택의 이유에 대해 얘기하고자 한다

### Kodeploy 오브젝트 스토리지 기능 구현

1. **앱 코드 변경 최소**
    - R2의 S3 호환(SigV4) → AWS SDK 거의 그대로기에 **엔드포인트만 교체하면 됨**
2. **비용**
    - R2 무료티어: 쓰기 100만/읽기 1000만/저장 10GB + egress 무료
    - 이미지는 "볼 때마다 전송(egress)"이 주 비용인데, **AWS·OCI는 egress 유료(GB당)지만 R2는 무료**
    - (저장 비용은 R2도 있지만 10GB 무료)
3. **운영 부담**
    - 현재 관리중인 인프라는 K8s가 돌아가는 OCI, 앞단을 담당하는 Cloudflare로 2가지 벤더를 쓰고 있다
    - **S3를 사용할경우 관리 벤더가 늘어나는 단점, 자체 호스팅 같은 경우는 복제, 백업, 격리 단점**
4. **테넌트 격리**
    
    격리는 셋 다 가능하지만 자동화 부담이 다르다.
    
    - **R2** = 토큰에 버킷이 박힘 → 토큰 발급 한 번이면 격리 완성.
    KoDeploy는 앱마다 전용 버킷(kd-{app})을 만들고 그 버킷에만 스코프된 토큰을 발급한다.
    토큰 정책의 resources가 단일 버킷이라, 발급된 자격증명은 그 버킷 밖은 못 봄
    - **S3** = IAM 유저+정책(JSON)을 따로 만들어 연결해야 함 → 단계가 많아 자동 발급이 무거움. 대신 조건(IP·시간 등) 같은 세밀함은 S3가 강함
    - **OCI** = compartment까지 끼어 더 무겁다.
    
    **재배포마다 토큰 자동 발급·회전**엔 R2의 "버킷=토큰"이 코드로 짜기 단순했다.
    

4가지를 비교했을 때 코드 변경이 적고, 가성비 좋고, 운영부담이 덜하고 테넌트 격리도 잘 되는
**R2를 실행할 때 자동으로 Endpoint를 환경 변수로 넣어주는 걸로 기능을 제작하였다**

### 다일로 앱 코드 변경 -  거의 0에 가까웠다 (+44, -8)

S3만 볼 줄 아는 다일로 앱 자체 코드 수정 방향은  `S3_ENDPOINT` 유무로 갈리게 수정하였다

**빈값=AWS 유지, 값 있으면=R2**

```java
// S3Config.java
@Value("${cloud.aws.s3.endpoint:}")
private String endpoint;

S3ClientBuilder b = S3Client.builder()
        .region(Region.of(region))
        .credentialsProvider(DefaultCredentialsProvider.create());

if (!endpoint.isBlank()) {                 // 값이 있을 때(=R2)만
    b.endpointOverride(URI.create(endpoint))
     .serviceConfiguration(S3Configuration.builder()
             .pathStyleAccessEnabled(true).build());
}
```

- 빈값이면 `if` 건너뜀 → SDK가 region으로 AWS 주소 조립 → **기존 AWS 유지**
- 자격증명은 `DefaultCredentialsProvider`가 `AWS_*` env 자동으로 읽음 → 자격증명 코드 0줄 수정
- 운영 브랜치인 AWS에 코드를 써도, KoDeploy에 써도 자동으로 R2, S3를 고르기에 안 깨지게 수정하였다

### rclone으로 S3 → R2 복사

기능과 호환성을 맞췄으면 이제 이미지를 옮겨야 할 때다

rclone config에 S3 remote + R2 remote를 등록하여 이미지를 전부 옮겨오고

```bash
rclone copy s3src:dailo-prod-static-2026 r2dst:kd-dailo --progress
```

![](/images/posts/my-paas-my-app-data/11.png)


Android 비공개 테스트 앱을 통해 이미지가 업로드 되고 보이는지에 대한 테스트를 완료했다

#### 좌 - Kodeploy, 우 - 다일로

![](/images/posts/my-paas-my-app-data/12.png)
(귀여운 고양이 잘 들어갔네요)

2부에서는 **트래픽을 어떻게 옮겼는지** - origin을 어떻게 잠갔고(mTLS에서 헤더 검증으로), 유저가 자기 도메인을 붙이는 커스텀 도메인 기능, 그리고 apex 도메인이 막혔던 이야기를 다룬다. 
1부가 **"데이터를 어떤 방식으로 옮겼나"**의 흐름이었다면, **2부는 그 과정에서 부딪힌 트러블슈팅이 비교적 많이 다룰 것이다**

## 2부에서 계속

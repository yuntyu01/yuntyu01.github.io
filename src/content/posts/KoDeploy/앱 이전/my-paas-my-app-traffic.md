---
title: "[2편] 내 PaaS에 내 앱 올리기 - 트래픽편"
date: "2026-06-05"
description: "Dailo 이전 2편. 커스텀 도메인을 Cloudflare for SaaS로 붙이고, origin mTLS와 부딪힌 원인을 계층별로 좁혀 풀었습니다."
tags: ["Cloudflare", "커스텀 도메인", "TLS"]
series: "KoDeploy"
velog: "https://velog.io/@yun60/2편-내-PaaS에-내-앱-올리기-트래픽편"
thumbnail: "/images/thumbs/my-paas-my-app-traffic.webp"
---
> 2부작 중 2편. 1편이 데이터(R2 이미지 + DB)를 옮긴 흐름이었다면, 2편은 **트래픽 차례**다 - origin 보안을 mTLS에서 헤더 검증으로 전환, 유저가 자기 도메인을 붙이는 커스텀 도메인 기능, 그리고 apex 도메인 앞에서 막혔던 벽까지. 1편보다 삽질이 훨씬 많았다
> 

---

[**[1편] 내 PaaS에 내 앱 올리기 - 데이터 편**](/posts/my-paas-my-app-data/)

## 0. 현재 상태

데이터는 옮겼으니, 이제 트래픽이 KoDeploy origin(Envoy Gateway)로 들어오게 해야 한다
현재 origin엔 **2가지 잠금**이 걸려있다

- **레이어 A - IP allowlist:** NLB가 Cloudflare edge IP에서 온 트래픽만 받는다
- **레이어 B - origin mTLS:** 기존 TLS는 서버 인증서만 받지만 mTLS는 Envoy가 "연결 거는 쪽(Cloudflare)이 Cloudfare 전용 클라이언트 인증서(origin-pull certificate)를 제시하는지"도 검증하며 없으면 거부한다

현재 상태에서 `dailoapp.com`의 트래픽을 받기 위해 사용자가 사용하던 도메인을 등록하는 기능을 만들려 했다

**하고자 하는 단계** 

1. 유저가 자기 도메인(`shop.acme.com`)을 자기 앱에 붙이는 **커스텀 도메인 기능** (Cloudflare for SaaS)
2. 해당 기능을 통한 Dailo 본인 도메인(`dailoapp.com`)을 KoDeploy로 도메인 전환

## 1. 커스텀 도메인 - 왜 CF for SaaS였나

커스텀 도메인 기능을 어떻게 구현할지에 대한 3가지 선택지가 있었다

#### **1. CF 안 거치고 origin(NLB) 직결**

유저가 CNAME으로 origin(NLB)의 IP를 직접 가리키고, cert는 내가 cert-manager로 발급·갱신

- 근데 이러면 그 트래픽만 CF 보호(CDN·DDoS) 밖으로 빠짐
- origin은 CF IP만 받게 잠가놨는데(레이어 A) 그 allowlist를 열어야 함
- cert 운영도 유저 수만큼 관리해야 함

#### **2. 유저 zone을 통째로 이전받기**

유저 도메인의 네임서버를 CF로 옮기게 하기

- 확실하지만 "도메인 DNS 전체를 맡기세요"는 유저한테 과한 요구
- CNAME 한 줄 vs 네임서버 이전  온보딩 마찰이 크다 (추후 타협하여 Dailo는 해당 기능을 쓰게 됨)

#### **3. CF for SaaS (custom hostname)**

유저는 CNAME 한 줄, cert는 CF가 자동 발급·갱신, 트래픽은 CF를 거쳐 들어와 기존 origin lock(2겹)과 그대로 정합

- Free 플랜에 100개까지 포함이라 비용 0 (Vercel·Netlify가 유저 도메인을 받는 방식)

> **CF for SaaS** 
고객이 자기 도메인(CNAME 한 줄)으로 우리 SaaS를 쓰게 해주고, 인증서 발급·갱신·트래픽 보안은 Cloudflare가 알아서 해주는 제품
> 

딱 봐도 정답은 정해져있다 **CF for SaaS**로 하기로 했다

---

## 2. origin mTLS vs 커스텀 도메인

테스트를 하기 전에 구축한 흐름을 잠깐 정리하려고 한다

내 다일로 도메인으로 테스트용 서브도메인`test.dailoapp.com`을 잡고, 세 군데를 세팅했다.

```yaml
[curl test.dailoapp.com]
   ↓ ① (Route53) DNS 조회: test.dailoapp.com → CNAME → Cloudflare edge IP
[Cloudflare (SaaS)]
   ↓ ② 커스텀 호스트네임 확인 → fallback origin(origin.kodeploy.com)으로 프록시
   ↓    origin.kodeploy.com → DNS 조회 → NLB IP
   ↓    (이때 origin-pull 인증서를 제시하는가? ← 이게 문제의 지점)
[NLB] → [Envoy (mTLS 검증 지점)]
   ↓ 
[앱]
```

**① Cloudflare - SaaS custom hostname 등록**

kodeploy.com zone(CF)에 `test.dailoapp.com`을 custom hostname으로 등록한다(API)
이게 있어야 CF가 이 트래픽을 받았을 때 "KoDeploy SaaS 거구나" 하고 fallback origin(`origin.kodeploy.com`)으로 넘기고, cert도 발급해준다.

**② Route53 - CNAME 추가**

Route53의 `dailoapp.com` 존에`test.dailoapp.com CNAME → origin.kodeploy.com`을 넣는다 
트래픽을 CF로 보내는 레코드이자 내 DNS에 레코드를 넣을 수 있다는 것이 도메인 소유 증명이기에 SaaS의 hostname이 활성화된다.

**③ Envoy - 기존 상태 그대로**
mTLS 사용 상태로 (enforce) HTTPRoute hostnames에 `test.dailoapp.com`만 주입해서 라우팅되게 했다.

근데 여기서 생각해야 할 부분이 있다 **Cloudflare for SaaS** 커스텀 도메인 트래픽이 **Origin의 mTLS를 통과할 수 있는가**

### 테스트

테스트용 커스텀 호스트네임(`test.dailoapp.com`, 내 소유 도메인)을 Route53에 등록된 상태에서 Origin의 mTLS enforce 상태에서 쳐봤다.

```bash
$ kubectl patch clienttrafficpolicies.gateway.envoyproxy.io origin-mtls -n default --type merge -p '{"spec":{"tls":{"clientValidation":{"optional":false}}}}'

# 좀 시간이 지난 후 시도 (patch 반영 지연)
$ curl -v https://test.dailoapp.com/healthz
```

![](/images/posts/my-paas-my-app-traffic/01.png)


결과는 **전부 520 -** enforce mTLS에서 커스텀 도메인이 동작을 안 한다. (mTLS를 풀면 곧바로 앱이 직접 준 404가 떴다 → 경로는 멀쩡하나 mTLS가 막았다는 뜻이다 )

> 정책을 토글하고 바로 재면 반영 타이밍에 속는다. 충분히 기다리고 연속으로 재서 안정 상태를 봐야 한다. 글쓴이는 그거 때문에 테스트에서 몇 번 헷갈렸다
> 

### 계층 이야기 - 왜 막혔냐

#### 원인

520는 **525(핸드셰이크 거부)가 아니었다**는 것이 단서가 되었다. `curl -v`의 핸드셰이크는 멀쩡히 끝났고(`verify ok`), 막힌 건 그 다음이다 

요청 하나는 다리 두 개를 건넌다

```yaml
[방문자] ──다리①──> [Cloudflare] ──다리②──> [Envoy(origin)] ──> 앱
```

`verify ok`는 다리①(방문자↔CF)의 성공이고, 
죽은 건 **다리②(CF→origin)** - origin lock(mTLS)이 지키는 바로 그 다리다

다리②의 연결 하나를 시간순으로 펴보면, 같은 "이름"이 **세 번, 다른 시점에 다른 용도로** 실려 온다:

```yaml
t0  DNS    origin.kodeploy.com → NLB IP   ← 연결 전. 주소 찾기
t1  TCP    그 IP:443 접속                  ← 이름 안 실림 (L3-4)
t2  TLS    ClientHello: SNI=(모름)        ← 이 시점에 존재하는 유일한 이름 (L5-6)
t3  ★     mTLS 판정 "client cert 내놔"    ← enforce면 여기서 생사 결정
────────── 핸드셰이크 끝 ──────────
t5  HTTP   Host: test.dailoapp.com        ← mtls를 안 할 시 나왔던 값
```

여기서 **판정**이란 t3에서 Envoy가 client cert를 요구하고 검증하는 일이다.

mTLS가 적용된 상태에서 cert가 없으면 **연결은 t3에서 끝나고, t5는 영영 오지 않는다.** CF는 origin 응답을 못 받고, 요청자는 520을 본다. 
반대로 mTLS를 해제하면 t3에서 묻지 않고 통과 → t5에 Host가 도착 → 라우팅·서빙이 된다

520에러는 Client cert가 없기 때문이다

| 계층 | 무엇 | 우리 origin lock |
| --- | --- | --- |
| L3 | IP | 레이어 A - CF IP allowlist |
| L4 | TCP | - |
| L5-6 (TLS) | 인증서·SNI·mTLS | 레이어 B - origin mTLS (t3) |
| L7 (HTTP) | 헤더·경로 | (우회로 쓸 헤더 검증, t5) |

#### **왜 다리②에 cert가 없었나**

AOP = CF가 origin에 연결할 때 client cert를 내밀게 하는 기능
Per-hostname = AOP가 cert를 붙일 대상을 고르는 방식으로 명단제

AOP가 cert를 붙이는 기준은 "이 요청이 **누구 앞으로** 온 거냐"(요청된 호스트네임)다. per-hostname 목록엔 zone 안 이름(현재 세팅은 `api`, `dailo`)만 올라가는데, 커스텀 도메인은 남의 도메인이라 등록 자체가 안 된다. 

이 시점에 mTLS를 살릴 방법이 두 가지가 생각났다

#### 1. CF SaaS 트래픽에도 cert가 붙게 만들기

AOP 명단에 `origin.kodeploy.com`(fallback origin)을 추가해 보기
"커스텀 도메인 이름은 등록이 안 되니, 걔네가 가는 목적지 이름이라도 넣으면 먹히지 않을까?"라는 생각이었는데 AOP는 요청의 호스트네임만 보고 목적지는 안 보니까 매칭이 일어나지 않고, SaaS 트래픽엔 여전히 cert가 안 붙어서 **520**이 뜬다

| 요청 호스트네임 | 명단에 있나 | cert | 결과 |
| --- | --- | --- | --- |
| `api.kodeploy.com` | O (zone 소속) | 붙음 | 통과 |
| `test.dailoapp.com` | X (남의 도메인, 등록 불가) | 안 붙음 | **520** |
| (`origin.kodeploy.com`을 명단에 추가) | - 요청 호스트네임으로 등장 안 함 | 매칭 자체가 없음 | 무의미 |

#### **2. CF SaaS를 통한 커스텀 도메인 mTLS 면제**

zone 트래픽은 mTLS를 유지하고, cert 못 받는 커스텀 도메인만 검사에서 빼주기
근데 면제 여부는 **t3(클라이언트 인증서 요청)에서 결정**해야 하고, 그 시점의 이름은 SNI뿐이기에 즉 SNI 기준으로 listener를 갈라야 한다. 여기에 비용이 셋 붙는다.

1. **SNI 도박** **or 측정**
CF가 다리②의 SNI 칸에 뭘 적는지 모른다 
연결이 fallback origin으로 간다는 것과 SNI에 몰 적느냐는 별개다
SNI가 정확하게 몰 보내는지 모르는 채로 Envoy에게 mTLS 면제를 요구하는 건 힘들기에 해당 부분을 따로 측정해야 된다
2. **listener
현재 단일** listener에서 SNI 갈래로 쪼개는 Gateway 구조 변경을 해야한다
SNI가 커스텀 도메인을 사용하려면 유저가 늘 때마다 갈래 목록을 동적으로 관리해야 한다.
3. **자물쇠 2개**
면제 차선(= 플랫폼의 주력인 유저 트래픽)은 mTLS가 안 지키니, 보안 수준을 비슷하게 유지하려면 **어차피 헤더 검증을 따로 달아야 한다**

그리고 3번이 결정타였다. 3번에서 만들 헤더 검증은 Transform Rule을 사용하는데 Transform Rule은 zone/SaaS 가리지 않고 **모든 트래픽에** 헤더를 붙인다
헤더 하나가 전부를 잠글 수 있는데, 도박(1)하고 수술(2)해서 한 차선에만 mTLS를 추가로 다는 게 의미가 있나라는 생각이 들었다 

520이 확정된 순간 질문은 "mTLS가 되냐"가 아니라 **"mTLS를 살리는 길이, 다른 대안보다 나으냐"**로 바뀌었었다

커스텀 도메인은 헤더 검증, zone 트래픽은 mTLS + 헤더 검증 이렇게 둘로 갈 바엔 그냥 전부 헤더 검증으로 통일하면 되는 거 아닌가? 이런 생각이 들었다

> 이 글을 정리하며 CF 문서에서 발견한 게 있다. 해당 문서엔 **global/zone-level AOP는 zone의 모든 프록시 트래픽에 적용되며, SaaS 커스텀 호스트네임도 포함한다**고 명시돼 있다. 내가 쓰던 건 셋 중 per-hostname AOP였고, 테스트에서 실패한 것도 그 경로다. 
즉 **zone-level로 갈아탔으면 다르게 해결할 수 있었을지도 모른다.** 당시엔 이 답을 찾지 못해 테스트를 하고 실패했다. 다만 지금 당장 갈아타진 않으려 한다. 보안에 완벽은 없고, 현재 헤더 검증 + IP allowlist 구성은 문제없이 돌고 있고, 적용할 것들이 쌓여 있어 우선순위상 추후 과제로 남기려 한다
> 

---

## 3. 전환 - L7 헤더 검증

사실 AWS 때 Dailo는 CloudFront → ALB 사이를 **`X-Origin-Verify` 비밀 헤더**로 잠갔었다. CloudFront가 헤더를 붙이고 ALB가 검증하는 방식으로 mTLS와 목적이 같고, 헤더는 **L7(HTTP)**이라 위에서 본 SNI/listener 문제를 통째로 우회한다 (보안성은 mTLS가 좀 더 우위겠지만)

> **HTTPS가 항상 정답은 아니었다 - CloudFront 502 장애 분석**
> 

mTLS에서 얻은 교훈이 있다 "zone 설정이 SaaS를 덮느냐"는 기능마다 다르다는 것. AOP(TLS)는 안 덮었다. mTLS에 대한 PTSD가 와서 Cloudflare Transform Rules(헤더 추가, HTTP)도 SaaS에 적용되는지 검증해봤다

### 통제실험: control + treatment

- **treatment:** `test.dailoapp.com` (SaaS 커스텀 호스트네임)
- **control:** `probe.kodeploy.com` (in-zone 정식 호스트네임)

control을 둔 이유: treatment에 헤더가 안 오면 "SaaS가 안 덮어서"인지 "rule을 잘못 만들어서"인지 구분이 안 되기 때문이다. control(in-zone)이 성공해야 "rule 자체는 정상"이 보증된다

```bash
for host in test.dailoapp.com probe.kodeploy.com; do
  echo "--- $host ---"
  curl -s https://$host/ | grep -iE 'Host:|Cf-Ray|X-Origin-Verify'
done
```

![](/images/posts/my-paas-my-app-traffic/02.png)


**둘 다 성공** 
AOP(TLS)와 달리 Transform Rules(HTTP)는 SaaS를 덮었다

### 결정

- **단일 listener 유지**
- **origin lock = `X-Origin-Verify` 헤더 검증** - CF가 origin으로 가는 요청에 비밀 헤더를 붙이고 Envoy가 검증 mTLS가 안 되는 커스텀 도메인에, AWS 때 쓰던 그 방식으로 했다

암호학적으론 mTLS가 더 강하지만(공유 비밀은 유출되면 끝), 이건 후퇴가 아니라 **원래 프로덕션에서 쓰던 등급으로의 복귀라고 볼 수 있다(다일로는 이거 씀)**, 레이어 A(IP allowlist)가 그대로 남아 직타를 1차로 막는다.

---

## 4. 커스텀 도메인 기능 - 그리고 apex의 벽

origin lock을 헤더로 풀었으니, 이제 유저 커스텀 도메인 기능을 구현했다. CF for SaaS custom hostname을 만들고, Envoy HTTPRoute의 hostnames에 주입하는 방식이다

### 서브도메인

`api.dailoapp.com` 같은 서브도메인을 등록하고 → CNAME을 `origin.kodeploy.com`으로 → **바로 active + 서빙됐다.**

![](/images/posts/my-paas-my-app-traffic/03.png)


### apex

근데 문제가 있다 Dailo 앱은 서브도메인이 아니라 **apex(`dailoapp.com`)** 를 본다
앱에 하드코딩했기에 서브도메인으로 프론트 코드 변경 시 사용자한테 업데이트를 요청해야 하는데 안 좋기에 apex를 써보려고 노력하겠다

apex로 custom hostname을 활성화하려니

```
custom hostname does not CNAME to this zone.
The hostname is using Cloudflare and cannot be activated with TXT/HTTP validation token.
```

→ cert는 나는데 라우팅이 거부됐다 (`error 1001`).

### 공유 anycast IP라 zone 식별이 안 된다

- **서브도메인:** `CNAME → origin.kodeploy.com` → CF가 "아, 이건 KoDeploy SaaS zone 거"라고 식별 → 활성 OK
- **apex:** CNAME이 표준상 불가 → A 레코드로 CF anycast IP를 가리켜야 하는데, 그 IP는 **수많은 zone이 공유하기에** → CF가 IP만 보고 "이게 어느 SaaS zone 거"인지 식별 못 함 → 활성 거부(1001)

### TXT는 될 줄 알았지

곁가지로 TXT 삽질도 있었다. 처음엔 기대를 갖고 한 번 해봤다
TXT로 소유권을 증명하면, CF가 그걸 보고 "아 이 도메인은 KoDeploy zone 거구나" 하고 트래픽을 이어줄 수 있지 않을까. 즉 TXT가 검증뿐 아니라 식별까지 풀어줄 수 있지 않을까라는 생각을 했다.

결과부터 말하면 둘 다 아니었다 
검증조차 TXT가 필요 없었다 A 레코드를 이미 CF로 돌린 뒤라 "트래픽이 이미 CF로 오고 있으니 HTTP로 자동 검증한다"며 **TXT는 무시됐다(TXT pre-validation은 트래픽을 돌리기 전 사전 검증용이었다).**
그리고 알아보니 식별은 애초에 TXT가 풀 수 있는 문제가 아니었다. **소유권 검증은 등록 시점에 한 번 일어나는 절차고, 라우팅 식별은 트래픽이 도착하는 매 순간의 판단이다.** 
CF는 그 순간 **외부 DNS의 TXT 따위를 조회하지 않고 내부에 등록된 명시적 연결(CNAME)만 본다.** 

사실 "dailoapp.com이 어느 zone 소속인지"는 CF가 알고 있었다
custom hostname으로 등록됐고 cert까지 발급됐으니까 그런데도 활성화는 1001로 거부됐다. 에러 메시지가 지목하는 건 정보의 부재가 아니라 CNAME 연결의 부재였다: "custom hostname does not CNAME to this zone." **즉 CF는 custom hostname의 장부상 매핑이 아니라 DNS 차원의 명시적 연결(CNAME)을 요구하는 것으로 보인다**
아마 공유 anycast IP로 들어오는 임의 도메인을 장부만 믿고 라우팅하면 멀티테넌트 보안 문제가 열리기 때문일 것이다. 어쨌든 확실한 건, 검증 방식을 뭘 쓰든 결말은 1001이라는 것이었다.

### Apex Proxying은 Enterprise - R2처럼 카드로 안 켜진다

CF for SaaS가 apex를 공식 지원하는 길이 있긴 하다 **Apex Proxying**(전용 IP 할당) 근데

> R2는 사용량 과금이라 카드 등록으로 셀프 활성화됐는데, **Apex Proxying은 Enterprise 애드온**이었다  "account team에 문의"(영업 계약). 개인 프로젝트가 카드로 켤 수 있는 게 아니었다.
> 

### 결정 - 유저 기능은 서브도메인(CNAME) 전용

무료/셀프로 유저의 임의 apex를 일반적으로 지원할 방법이 없었다 → **유저 커스텀 도메인은 서브도메인 전용으로 확정.** (Vercel·Netlify도 무료 구간은 같은 한계다 그리고 얘넨 자기 IP 대역을 가진 큰 회사라 apex가 되는 거고 난 가난한 대학생이다)

- 코드: `domains.py`에서 apex 분기·TXT 검증 제거
- UI/가이드: "서브도메인만 가능, CNAME 한 줄" 명시

---

## 5. Dailo 네임서버 이전

유저 기능은 서브도메인 전용으로 정했지만 - Dailo 앱은 apex를 하드코딩하고 있어서(사용자한테 업데이트를 유도해서 못 바꿈), 유저 기능과 다른 방법으로 Dailo의 apex는 따로 해결하려 했다

### 해결 (이라 쓰고 타협이라 읽음)

`dailoapp.com`은 **내 소유 도메인**이니까, 유저처럼 SaaS custom hostname으로 가는 게 아니라 **네임서버 자체를 Route53 → Cloudflare로 이전**했다. 그러면 CF가 apex를 **CNAME flattening**으로 네이티브하게 처리한다 → SaaS 우회가 아예 필요 없어진다.

결국 마이그레이션을 위해 만든 사용자 도메인 등록 기능을 쓰지 않은 것이다 마이그레이션 때문에 SaaS연결까지 한 건데.. 근데 어차피 만들었어야 하는 기능이니까 됐다고 치자

순서:

1. CF에 사이트 추가(도메인 연결) → 기존 레코드 임포트 확인
2. apex `dailoapp.com` → `origin.kodeploy.com` (proxied)
3. **이 새 zone에도 X-Origin-Verify Transform Rule 추가** (안 하면 헤더 매칭 실패로 404)
4. **다 세팅한 뒤 마지막에** Route53의 네임서버를 Cloudflare로 전환

### HTTPRoute에 apex hostname 추가

유저 기능이 apex를 거부하므로(서브도메인 전용), Dailo의 apex는 `domains.py` 자동 주입 대상이 아니다. 처음엔 HTTPRoute hostnames에 `dailoapp.com`을 kubectl patch로 수동 추가했다.

```bash
kubectl patch httproute dailo -n tenant-xxxx --type merge \
  -p '{"spec":{"hostnames":["dailo.kodeploy.com","api.dailoapp.com","dailoapp.com"]}}'
```

근데 hostname 주입 함수는 DB에 등록된 도메인 목록을 기준으로 HTTPRoute를 동기화한다. 즉 수동 추가분은 다음 동기화 때 밀려날 수 있다. 그래서 `dailoapp.com`을 DB에 직접 넣어, 코드가 보는 진실의 원천(DB)과 실제 상태를 맞췄다.

### 결과

DNS 레코드를 정리했다. SaaS 시절 박아뒀던 apex A 레코드(CF anycast IP 2개)는 이제 의미가 없으니 지우고 zone이 CF 안에 있으니 apex에도 CNAME을 걸 수 있다(CNAME flattening)

```
dailoapp.com        CNAME → origin.kodeploy.com  (proxied)
api.dailoapp.com    CNAME → origin.kodeploy.com  (proxied)
```

도메인을 변경하고 나니 비공개 테스트의 앱 뿐만 아니라 실제 운영 중인 앱(**`dailoapp.com`**)도 정상동작하였다
![](/images/posts/my-paas-my-app-traffic/04.png)


---

## 6. 회고

무중단도 아닌, 그냥 데이터 옮기고 트래픽 옮기는 마이그레이션이었는데도 오래 걸렸다. 처음이기도 했고, 도그푸딩이라 옮기는 중간중간 기능(커스텀 도메인)을 만들면서 가서이기도 한 거 같다

항상 느끼는 거지만 **돈이 설계에 큰 영향을 끼치는 거 같다** 다일로는 지원금이 넉넉했기에 달에 25만원씩 쓰면서 여러가지 기능을 다 사용할 수 있었다 이중화도 할 수 있었고 읽기 전용 DB도 쓸 수 있었다 
하지만 지원금이 끊긴 지금은 DB 메모리도 부족해서 perf_schema를 껐고, egress가 무서워서 R2를 고르고 Enterprise 벽에 막혀 mTLS를 접고 헤더검증으로 가고(사실 다른 대안을 뒤늦게 찾긴했지만) 결국 이중화도 제공하지 못 했다

돈이 넉넉할 땐 정석을 골랐고, 없으니 차선을 골랐다. 다른 게 있다면 차선엔 "이래도 괜찮다"는 근거가 정석보다 많이 필요했다는 것. 242MB를 재고, 통제실험을 했던 이유다. **제약 안에서 근거 있는 차선을 고르는 것, 그게 엔지니어링이지 않나 싶다**

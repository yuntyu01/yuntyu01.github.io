---
title: "OOMKilled의 진짜 범인 - OS는 반려동물용인데 노드는 가축이었다"
date: "2026-05-14"
description: "control plane Pod이 13일 동안 98번 재시작됐습니다. dmesg로 범인을 dnf-makecache(2.36GB)로 좁히고 timer를 꺼서 막았습니다."
tags: ["Kubernetes", "OOMKilled", "Linux"]
series: "KoDeploy"
velog: "https://velog.io/@yun60/OOMKilled의-진짜-범인-OS는-반려동물용인데-노드는-가축이었다"
thumbnail: "/images/thumbs/oomkilled-real-culprit.webp"
---
> "OCI에서 K8s master 노드의 control plane Pod들이 13일간 누적 98회 재시작된 사건
(약 10일간 사정으로 인해 프로젝트를 진행하지 못 하여 확인이 늦음)
`kubectl describe`의 OOMKilled 파악과 `dmesg` 분석 끝에 진짜 범인은 OS 데몬 `dnf-makecache`(RSS 2.36GB)였다. 
Ansible IaC 환경에선 dnf 캐시가 잉여라는 판단하에 timer를 영구 비활성화하여 해결"
> 

## 0. 배경

![](/images/posts/oomkilled-real-culprit/01.png)

Kodeploy는 K8S 멀티테넌시 한국어 로그제공 자동배포플랫폼이며 가난한 대학생의 주머니 사정에 맞춰 OCI Free Tier를 위주로 리소스를 구성했다

### 리소스 구성

| 노드 | OCPU / RAM | 역할 |
| --- | --- | --- |
| master | 2 / 4GB | K8s Control Plane |
| worker1 | 2 / 10GB | 워커(사용자 앱) + 플랫폼 + 빌드 |
| worker2 | 1 / 10GB | 워커(사용자 앱)  |
| managed | 1 / 4GB | Ansible/kubectl 운영 |

한도내에서 control plane과 managed까지 포함하여 올리기엔 cpu가 부족할 거 같아 master node는 2ocpu 4ram으로 좀 빡빡하게 잡아 **얇은 지갑**에서 달에 약 17,000원씩 쓰기로 하였다

> **"디버깅의 출발점은 객관적 단서일 때도 있고 주관적 직감일 때도 있다. 중요한 건 그게 가설이라는 걸 인지하고 검증하는 일이다."**
> 

## 1. 문제 발생

master 노드가 응답을 안 했다. managed에서 `ssh master`도, `ansible master -m ping`도, `kubectl get nodes`도 다 안 통하거나 timeout이었다.

![](/images/posts/oomkilled-real-culprit/02.png)![](/images/posts/oomkilled-real-culprit/03.png)

oci 콘솔에서 master node를 재부팅 시에는 ssh연결, ansible ping가 kubectl 명령어가 잘 동작하는 걸 보고 **일단 안심했다. 근데 다음날 한 번 더 master node에 연결이 안 됐다. 어딘가 문제가 발생한 거 같다라는 생각을 했고 원인을 찾기로 했다**

### 1.1 kubectl get pod -A
![](/images/posts/oomkilled-real-culprit/04.png)

생각보다 나 없었을 때 문제가 많았던 거 같다 restart count가 곧 세자리 수를 찍기 직전이었다

재시작한 Pod들의 구성을 보니 **master에 있는 컴포넌트는 다 죽었고 워커는 멀쩡했다 master의 pod들이 공유하는 자원인 노드 자원이나 os가 문제일 거 같다**라는 생각이 들었다

### 1.2 free -h

#### `free -h`

처음 아키텍처를 짰을 때 얇은 지갑으로 인한 K8s에 다소 협소한 자원인 master node의 2ocpu 4ram에 대한 걱정이 있었고 그렇기에 자연스레 메모리 공간이 좀 부족한가? 라는 생각이 들어 확인해봤다

![](/images/posts/oomkilled-real-culprit/05.png)

**available이 2.1GB로 메모리는 여유**로워 보였고 “돈을 더 안 써도 되겠구나” 라는 안심이 살짝 되며 정확한 원인을 찾기위해 restart count가 가장 높은 calico-kube-controller를 자세히 봐야겠다고 생각했다

### 1.3 kubectl describe pod calico-kube-controllers -n calico-system

#### `kubectl describe pod calico-kube-controllers -n calico-system`

![](/images/posts/oomkilled-real-culprit/06.png)

처음 화면이 뜨고 가장 먼저 생각난 것은 Events를 보니 아 calico가 문제가 많긴 하구나 warn이랑 error가 널렸네 라고 생각이 들었다

근데 처음에 생각했던 건 node의 자원과 os 문제라고 생각했었기에 calico는 당연히 restart같은 문제가 있으니 error로그가 있는 건 당연할테고 이게 과연 핵심 문제인가 생각이 들었기에 일단 좀 더 자세히 보았다

![](/images/posts/oomkilled-real-culprit/07.png)

Last State를 보니 `Reason: OOMKilled`, `Exit Code: 137`. 결국 메모리 문제였다.

근데 좀 의아했다. **`free -h`로 본 게 불과 몇 분 전인데, available 2.2GB로 메모리가 멀쩡했는데?** Ansible로 일 시키는 중에 봐도 2.1GB는 여유 있던 노드에서 OOM이 났다는 게 굉장히 의아했다.

그러다 깨달았다. **`free`는 지금 이 순간의 스냅샷이지, OOM이 났던 그 시점의 메모리 상태가 아니다.** Pod이 죽은 건 지금이 아니었고, OOMKilled를 낸 프로세스는 자기 일을 끝내고 이미 메모리에서 빠져나간 상태였기에 **사건 당시의 메모리 상태를 봐야 했다**

메모리 상태의 타임라인이 필요했다. 재부팅 없이 노드가 살아있는 상태였으니, `dmesg`의 커널 링 버퍼에 그 시점 OOM 기록이 남아있을 거다

### 1.4 sudo dmesg -T | grep -B2 -A10 -i "out of memory\|killed process"

#### `sudo dmesg -T | grep -B2 -A10 -i "out of memory\|killed process"`

dmesg는 커널 링 버퍼를 보여주는 명령어로, OOM Killer가 발동된 기록도 여기 다 남는다. `-T`로 사람 읽기 좋은 시간으로 변환하고, grep으로 OOM 관련 줄만 추렸다.

![](/images/posts/oomkilled-real-culprit/08.png)

```yaml
[Wed May 13 03:58:38 2026] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),
  cpuset=oca.slice,mems_allowed=0,global_oom,task_memcg=/system.slice/dnf-makecache.service,
  task=dnf,pid=170467,uid=0
[Wed May 13 03:58:38 2026] Out of memory: Killed process 170467 (dnf)
  total-vm:2764448kB, anon-rss:2360396kB, file-rss:7148kB, shmem-rss:0kB,
  UID:0 pgtables:4792kB oom_score_adj:0
```

**dnf 혼자 2.36GB**. 4GB 노드의 60%다. 이 한 줄이 결정적이었다

로그에서 4가지 키워드로 주범을 알 수 있었다

- **task=dnf**
- **anon-rss:2360396kB (2.36GB)**
- **constraint=CONSTRAINT_NONE + global_oom**

#### task=dnf

OOM Killer가 **dnf 프로세스를 죽였다**는 뜻으로 보통 OOM에서 죽는 것은 oom_score가 가장 높은 프로세스이다

#### anon-rss:2360396kB (2.36GB)

RSS는 "Resident Set Size" - **RAM에 실제로 올라가 있는 메모리**

`anon`은 파일에 매핑되지 않은 순수 메모리(heap, malloc 등), 프로그램이 실행 중에 만든 동적 메모리로 버리면 날라가버려서 swap 없이는 ram에서 버리지 못한다 

| 종류 | 약자 | 뜻 | 비울 수 있나? |
| --- | --- | --- | --- |
| 가상 메모리 | **total-vm** (VSZ) | "이만큼 쓸 거다"라고 선언한 주소 공간 | 실제 RAM 안 쓰면 부담 0 |
| 익명 메모리 | **anon-rss** | heap, malloc 등 디스크에 원본 없는 RAM 점유분 | swap 있으면 O / 없으면 X |
| 파일 매핑 메모리 | **file-rss** | 실행 바이너리, mmap 파일 등 디스크에 원본 있는 RAM 점유분 | 항상 가능 (원본에서 다시 읽으면 됨) |
| 공유 메모리 | **shmem-rss** | 여러 프로세스가 같이 쓰는 메모리 (tmpfs, IPC, /dev/shm 등) | 보통 swap 필요 (anon과 유사) |

#### constraint=CONSTRAINT_NONE + global_oom

OOM이 발생한 이유의 분류이고 두 가지가 있다:

| 종류 | 의미 |
| --- | --- |
| `CONSTRAINT_MEMCG` | cgroup(컨테이너)의 메모리 한도 초과 |
| **`CONSTRAINT_NONE`** | **노드 전체 RAM 고갈** |

`global_oom`도 같은 의미로 **노드 자체에 메모리가 부족했다는 뜻이다.**

#### 한 줄로 합치면

> **"노드 전체 메모리가 고갈됐고(constraint=CONSTRAINT_NONE), 그 결과 RAM을 2.36GB 점유하던 dnf 프로세스가 OOM Killer에 의해 죽었다."**
> 

여기까지 보니 진단이 거의 끝났다.

- 범인: **dnf**
- 메모리 점유: **2.36GB / 4GB**
- 종류: **노드 전체 OOM**

근데 나는 새벽에 dnf를 쓴적이 없는데 왜 갑자기 2.36GB나 먹은 거지?라는 생각이 들었다

**dnf는 패키지 관리자인데 왜 메모리를 그렇게 많이 먹게 되었을까?**

```yaml
[Wed May 13 03:58:38 2026] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),
  cpuset=oca.slice,mems_allowed=0,global_oom,task_memcg=/system.slice/dnf-makecache.service,
  task=dnf,pid=170467,uid=0
```

로그를 다시 보면 죽은 dnf 프로세스는 **`dnf-makecache.service`에 속한 프로세스**였다. systemd timer가 1시간마다 자동 실행하는 **패키지 메타데이터 캐싱 작업**이다. 즉 OS가 백그라운드로 돌리는 자동 작업이 메모리 폭주를 일으킨 거였다.

## 2. 해결방안

`dnf-makecache.service`가 RAM 2.36GB를 점유해서 4GB 노드 전체가 OOM에 빠졌고  해결 방안으로 3개 정도를 생각해볼 수 있었다

- **노드 스케일업**
    
    master의 ram을 4GB→ 6~8GB로 증가시키는 것이고 제일 간단하지만 가난한 대학생에겐 지속적으로 돈을 나가는 방법보단 본질적인 문제를 해결하는 게 나을 거 같다
    
- **cgroup memory limit 박기**
    
    다음으로 떠올린 건 `MemoryMax=300M` 같이 cgroup 한도를 거는 것. 그러면 dnf가 300MB 넘으려 할 때 cgroup OOM이 발동해서 dnf만 죽고 K8s Pod들은 안전해진다. 근데 **이건 OOM의 위치만 노드 전체 → cgroup OOM으로 옮긴 거 아닌가?** dnf는 매번 300MB에서 죽으니 메타데이터 캐싱 자체가 영영 실패하기에 해결이라고 할 수 없다
    
- **dnf 손보기**
    
    손보는 방법엔 3가지 정도 방안이 떠올랐다 
    
    1. **dnf를 메모리 적게 쓰게 튜닝?** 이건  내가 할 수 있는 일이 아닌 거 같고 자원을 많이 써야될 거 같다
    2. **실행 주기 늘리기?** 결국 죽는 건 죽는 거다
    3. **timer 자체를 꺼버리기?** 근데 그럼 캐시가 영영 갱신이 안 된다 근데 그게 우리 프로젝트에서 정말 문제가 될까?? 라는 생각이 들었다

#### 2.1 핵심 방안 통찰

여기서 멈춰서 본질에 대해 생각해보았다

“우리 환경이 정말 dnf 캐시가 필요한 환경인가?”에 앞서 dnf-makecache.timer를 쓰는 이유를 좀 찾아봤다

사람이 ssh로 들어와 dnf 명령어를 자주 칠 때 메타데이터를 매번 다운로드 하면 느리기에 미리 캐싱해두면 빠르게 쓰기 위함이다

즉 노드를 사람이 자주 만진다는 전제이다

그런데 본 프로젝트인 kodeploy는?

- 모든 노드 설정은 Ansible playbook으로 관리 (IaC)
- 새 패키지 설치 필요시 playbook 수정

→ 사람이 SSH로 들어와 dnf install을 직접 칠 일이 거의 없음

이런 상황에서 메타데이터를 캐싱하는 게 합리적인가? 
아니다 우리 환경에서 dnf-makecache는 자원 낭비다

> Oracle Linux 9는 dnf-makecache 같은 무거운 데몬을 기본으로 깔까? 2.3GB의 메모리를 잡아먹는 건 서버로써 비효율적이다. RHEL을 모티브로 했기에 IaC도 K8s도 없던 시절에 사람이 직접 관리하는 것이 표준일 때 그 철학이 그대로 내려온 거 아닐까 라는 생각이 들었다
> 

## 3. 결정 - 영구 비활성화

답은 명확해졌다. dnf-makecache.timer를 영구히 끄는 것이 맞다

필요하면 playbook에 명시적으로 한번 dnf makecache를 부르거나 dnf install시 자동으로 메타데이터를 받게 두게 한다거나 어쨌든 매시간 자동으로 2.3GB를 태울 이유가 없다

#### 3.1 Ansible playbook 추가

master node만 수정하기 보단 같은 상황과 환경인 모든 노드에 일관되게 적용하였다

```yaml
# ansible/playbooks/00-base.yml
- name: Stop and mask dnf-makecache timer (IaC mode, K8s-dedicated node)
  systemd:
    name: dnf-makecache.timer
    enabled: no
    state: stopped
    masked: yes

- name: Configure dnf to never auto-refresh metadata
  blockinfile:
    path: /etc/dnf/dnf.conf
    block: |
      keepcache=0
      metadata_expire=-1
    marker: "# {mark} ANSIBLE MANAGED — IaC mode"

- name: Clean existing dnf cache
  command: dnf clean all
  changed_when: true
```

- **`masked: yes`** - disable만 하면 systemd가 의존성으로 다시 켤 수 있기에 mask로 강제 잠금하였다
- **`metadata_expire=-1`**  - timer 꺼도 `dnf install` 호출 시 metadata가 stale이면 자동 갱신 시도하기에 막았다

## 4. 결과

playbook을 모든 노드에 적용 후 이틀 동안 확인하였다

- master Pod 재시작 누적: 멈춤
- dmesg OOM 이벤트: 더 이상 안 찍힘
- 노드 자체 재부팅: 없음
- 4GB 안에서 control plane이 안정적으로 동작

다만 관측 기간이 이틀이라 짧다. 원래 사건이 13일에 걸쳐 98회였던 걸 생각하면 이틀은 "재발하지 않았다"까지고 "안정화됐다"고 단정할 구간은 아니다. 이후로도 dmesg와 재시작 카운트를 계속 보고 있다.

잃은 것과 얻은 것을 정리하자면

| 잃은 것 | 얻은 것 |
| --- | --- |
| dnf install 첫 실행 시 metadata 10~30초 추가 (현재는 `metadata_expire=-1`로 갱신 자체가 막혀 있음) | 매시간 무인으로 돌던 2.36GB 스파이크 제거 |
| `dnf list updates` 즉답 (현재 환경에선 잘 안 씀) | control plane Pod 안정화 |
| 자동 보안 메타데이터 갱신 (수동 갱신에도 같은 스파이크가 따라옴) | 4GB 안에서 K8s가 숨 쉴 공간 |
|  | 비용 추가 0원 |

여기서 표현 하나를 정확히 해두고 싶다. 없앤 것은 **스파이크 자체가 아니라 스파이크가 무인으로 반복되는 구조**다. 캐시가 없는 상태에서 갱신을 걸면 같은 2.36GB가 그대로 온다. 시간당 1회로 자동 실행되던 것이 내가 의도해서 부를 때만 오는 것으로 바뀐 것이고, 그 차이가 control plane의 안정성을 만들었다.

## 5. 회고

### 5.1 철학 추측에 대한 분석

Oracle Linux9(Redhat)은 사용자의 지속적인 관리와 유사한 철학을 갖고 있지 않을까라고 중간에 추측했었는데 글을 정리하면서 관련된 Red Hat 공식 블로그글을 찾을 수 있었다.
**Red Hat의 Scott McCarty가 2016년 공식 블로그에 정리한 글**이 있었다.

> [RedHat 공식블로그 - Container Tidbits: Does The Pets vs. Cattle Analogy Still Apply?](https://www.redhat.com/en/blog/container-tidbits-does-pets-vs-cattle-analogy-still-apply)
> "Like pets, you give traditional virtual machines their 'shots'
> when they are first created (via Puppet, Chef, Ansible, or through
> manual updates)... if they get 'sick', you log into them,
> troubleshoot problems, fix problems."

디버깅 당시 막연히 추측했던 **'dnf-makecache라는 2.3GB 메모리 스파이크가
발생하는 건 RHEL의 옛 모델 철학이 그대로 내려온 거 때문이 아닐까'**가
이 분석과 맞아떨어졌다.

**전통적 VM은 'pet 모델'이고, Ansible로 첫 셋업하고 아프면 SSH로 들어가 고치는 게 표준**이었다.
**dnf-makecache는 그 pet을 위한 편의 기능**이고, **KoDeploy의 노드는 사람이 직접 만지지 않고 코드(Ansible)로 일괄 관리되며, 문제 생기면 고치는 게 아니라 교체하는 cattle(가축)이다**. 전통적 VM(pet)디자인과 우리 운영 모델(cattle)의 차이에서 비롯된 문제였다.

그러면 어째서 개선하지 않았는가라는 생각이 들었는데, 찾아보니 Red Hat
자체는 이 미스매치를 인식해서 RHCOS라는 cattle용 immutable OS를 따로
만들고 OpenShift에 강제 적용해왔다. 그런데 Oracle Linux는 RHEL의 100%
binary compatible clone이라 RHEL의 디자인 철학을 그대로 물려받았다.
오라클 클라우드의 K8s 전략은 OKE(Oracle Container Engine for
Kubernetes) 매니지드 서비스로 추상화하는 방향이었지, OS 차원의 cattle화는
아니었기 때문이지 않을까 싶다.

### 5.2 Swap에 대한 K8s의 정책 변화

K8s 1.28(2023)부터 **swap이 정식 지원됐다**는 걸 알았다. 현재 kodeploy의 k8s버전은 1.35라 켤 수 있는 환경이었다.

그럼 swap이 우리 문제에 답이 될 수 있을까? **OOM 자체는 막을 수 있었을 거다.**
dnf-makecache가 매시간 발동하고 일 끝나면 메모리를 해제하니, swap이
매시간 받쳐주는 패턴이 가능하긴 하다.

그치만 **상시로 켜두는 건** 좋은 운영이 아닌 거 같다. 매번 dnf가 폭주할 때마다 노드가 swap thrashing
상태에 빠져 1~2분씩 굼떠지고, master는 control plane 노드라 etcd가
디스크 I/O 경합으로 응답 지연 가능성이 크다. **OOM은 막아도 클러스터 자체가
주기적으로 불안정한 상태가 된다.** 무엇보다 폭주가 매시간 온다는 것 자체가 문제인데, swap은 그걸 견디게 해줄 뿐 없애지는 못한다.

그래서 원인 쪽을 먼저 껐다. 다만 이건 **swap이 필요 없다는 뜻이 아니라 상시로 켜둘 이유가 없다는 뜻**이었다. 주기 실행이 사라진 지금은 전제가 달라졌고, 이 얘기는 5.3에서 이어진다.

### 5.3 남은 문제 - 갱신 경로

`metadata_expire=-1`은 timer를 꺼도 `dnf install` 시 자동 갱신이 도는 걸 막으려고 넣은 설정이다. 이건 캐시가 만료되지 않는다는 뜻이라, 새 패키지 버전이 올라와도 dnf는 모른다.

처음엔 이걸 부작용이라고 생각했는데 다시 보니 IaC 환경에서는 오히려 방향이 맞다. 매번 최신을 받는다는 건 어제 만든 노드와 오늘 만든 노드의 패키지 버전이 달라진다는 뜻이고, playbook을 돌릴 때마다 코드에 안 적힌 변경이 따라 들어온다는 뜻이다. **재현성이 깨지는 쪽이다.** 버전을 코드에 고정해두고 올릴 때만 의도적으로 갱신하는 게 IaC의 방식에 가깝다.

그래서 남는 문제는 "갱신을 어떻게 매번 할 것인가"가 아니라 **"연 몇 번의 계획된 갱신을 어떻게 안전하게 치를 것인가"**다. 보안 패치는 버전을 고정해도 결국 올려야 하고, 그때 `dnf clean all` 후 makecache가 필요한데 그게 2.36GB다.

cgroup 한도는 답이 아니다. 2번에서 접은 이유 그대로 dnf만 죽고 갱신은 실패한다. **같은 잣대를 내 결정에도 적용하면**, 지금의 조치는 OOM의 위치를 옮긴 게 아니라 갱신 비용을 낼 시점을 미뤄둔 것이다.

후보는 셋 정도로 본다

1. **갱신할 때만 swap을 임시로 켠다** — swapfile을 만들어 켜고, 갱신하고, 끄고 지운다. 5.2에서 swap을 접은 근거가 "매시간 thrashing"이었는데 그 전제가 사라졌으니 여기선 성립한다. 연 몇 번이면 감당할 만하고 재부팅도 비용도 없다
2. **잠깐 스케일업했다 내린다** — 확실하지만 OCI에서 shape 변경은 인스턴스 재시작이 필요하고, Free Tier 한도 안에서 다른 노드 자원을 빼와야 한다
3. **노드를 새로 만든다** — cattle 논리를 끝까지 밀면 이쪽이 일관되지만, master는 etcd가 있어서 그렇게 간단히 버리기 어렵다

지금 상태를 한 줄로 정리하면 이렇다. **무인 반복은 없앴고 버전 고정은 IaC 방향에 맞지만, 계획된 갱신을 치를 방법은 아직 정하지 못했다.**

4GB 노드 하나가 가르쳐준 게 많았다. 이래서 직접 구축하면서 프로젝트 하라는 거 같다

## 6. 배운점 정리

1. **여러 Pod이 같이 죽는 패턴 = 노드 단위 문제 의심**
단일 Pod 문제면 한 Pod만 죽을 가능성이 크다
함께 죽는다면 그들이 공유하는 자원의 소유자가(노드 자원, OS 데몬 등)가 원인이다

2. **kubectl describe의 가장 중요한 정보는 Last State**

    출력 아래쪽 Events 섹션의 빨간 Warning/Error가 시선을 끌지만,
    진짜 핵심은 위쪽 Containers 섹션의 State, Last State, Reason이다.

3. **free는 스냅샷, dmesg는 타임라인 (휘발성이기에 재부팅시 journalctl 사용)**
메모리 문제는 항상 시간순으로 봐야 한다.

4. **메모리 한도를 박으면 OOM이 안 일어나는 게 아니라 OOM의 위치만 옮긴다.**
진짜 해결은 폭주의 원인 자체를 없애야한다
그리고 이 잣대는 내 결정에도 적용해야 한다. 이번 조치도 폭주 자체를 없앤 게 아니라 실행 시점을 옮긴 것이었고, 그걸 "원천 차단"이라고 부르지 않는 게 중요하다

5. **OS 디자인 모델과 운영 모델을 고려해서 적용해야 한다.**
pet 모델을 위한 OS의 기본 데몬은 cattle 노드에선 잉여가 되고, 자원이 빡빡한 환경에선 그 잉여가 OOM이라는 비용으로 드러난다.

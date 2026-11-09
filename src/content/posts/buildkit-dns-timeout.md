---
title: "DNS Timeout 범인 찾기 - K8s의 길과 클라우드의 입구 막기"
date: "2026-05-15"
description: "BuildKit 빌드가 DNS Timeout으로 실패했습니다. 가설 다섯 개를 하나씩 기각한 끝에 범인은 K8s 밖, OCI VNIC의 source/destination 검사였습니다."
tags: ["Kubernetes", "Calico", "DNS", "OCI"]
series: "KoDeploy"
velog: "https://velog.io/@yun60/BuildKit-DNS-Timeout의-진짜-범인-K8s가-깐-길과-클라우드가-막은-길의-미스매치"
thumbnail: "/images/thumbs/buildkit-dns-timeout.webp"
---
## 0. 배경

![](/images/posts/buildkit-dns-timeout/01.png)

KoDeploy는 K8s 멀티테넌시 한국어 로그 제공 자동 배포 플랫폼이며, GitHub 링크 입력 시 자동 배포를 목적으로 MVP를 개발 중이다.

Core 앱의 `/deploy` 엔드포인트에 GitHub repo 주소와 해당 웹의 포트를 넣으면, worker에서 BuildKit Job이 빌드한 후 Deployment + Service를 생성해 배포하는 로직이다.

(KoDeploy의 자원 구성과 환경은 [이전 글](/posts/oomkilled-real-culprit/)에서 다뤘다.)

## 1. 문제

GitHub repo로 첫 배포 테스트를 시도했다. 그런데 Deployment, Service, Pod이 생성되지 않았다

당연히 처음부터 성공할 거라 생각은 안 했다 

디버깅 위해 `kubectl describe jobs build` 를 수행하였다

![](/images/posts/buildkit-dns-timeout/02.png)

BuildKit Job이 에러로 종료됐고, 재시도 횟수(`backoffLimit`)를 다 채우고 최종 실패했다

더 구체적인 원인을 보기 위해 Pod 로그를 확인했다

#### `kubectl logs build`

![](/images/posts/buildkit-dns-timeout/03.png)

```yaml
#1 [internal] load git source https://github.com/docker/welcome-to-docker.git#main
#1 DONE 6.4s
#2 [internal] load metadata for [docker.io/library/node:22-alpine](http://docker.io/library/node:22-alpine)
#2 ERROR: dial tcp: lookup [auth.docker.io](http://auth.docker.io/): i/o timeout 
```

`#1`을 보면 GitHub에서 소스 코드 받아오는 건 성공했다. `#2`를 보면 `docker.io`의 메타데이터를 받으려다 DNS lookup에서 timeout이 났다.

**여기서 이상한 점은** 같은 Pod 안에서 같은 시간대에, GitHub은 잘 풀려서 소스를 받아왔는데 `docker.io`만 DNS timeout이 났다. 인터넷이 끊긴 거였다면 둘 다 안 됐어야 하는데, 왜 GitHub는 되고 docker는 안 될까? 

## 2. 문제 원인 도출

진단 결과를 먼저 말하면, 진짜 원인은 K8s 안에 있지 않았다. 그 결론에 도달하기까지 5개의 가설을 세우고 검증하고 기각하는 과정을 거쳤다.

### 2.1 첫 의심 - 인터넷?

**가설**: 가장 먼저 떠오른 건 현재는 노드가 전부 Private Subnet에 있기에 단순 인터넷 문제인가? 라는 생각이 들었다. 노드가 외부 인터넷에 못 나가는 상황이면 DNS timeout이 날 수 있다

**검증**: 사실 이 가설은 직전에 검증했기에 기각됐다. 같은 Pod의 `#1`단계에서 `git clone <https://github.com/>...`가 6.4초만에 성공했기때문이다. 

인터넷이 끊겼다면 GitHub도 안 받아졌어야 한다.

**결과**: 인터넷 자체가 아니라 **DNS 어딘가의 문제**로 좁혀졌다

### 2.2 두 번째 의심 - CoreDNS?

#### **가설**

docker.io의 lookup 문제(DNS)에 ****직전 게시물에서 볼 수 있듯이 OOM으로 인한 문제가 있었기에 CoreDNS가 내가 모를 연쇄 작용으로 죽었나? 싶어 확인해보았다

#### **검증**

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

![](/images/posts/buildkit-dns-timeout/04.png)

Pod 자체는 잘 살아있었다 

```bash
kubectl logs -n kube-system coredns 
```

![](/images/posts/buildkit-dns-timeout/05.png)

"Failed to watch"는 CoreDNS가 Kubernetes API Server의 리소스 변경을 감시하는 연결에 실패했다는 의미였다. 

외부 도메인 forwarding 자체가 API Server watch에 의존하는 것은 아니므로 이것만으로 auth.docker.io timeout의 원인이라고 볼 수는 없었다. 

다만 당시 master의 반복적인 재부팅 이력이 있었기 때문에 CoreDNS 상태 이상 가능성을 확인하기 위해 재시작 후 다시 테스트했다.

#### **결과**

```bash
kubectl rollout restart deploy/coredns 
```

![](/images/posts/buildkit-dns-timeout/06.png)

여전히 안 된다

### 2.3 세 번째 의심 - Service / kube-proxy?

 CoreDNS를 재시작해도 증상은 그대로였다.

적어도 CoreDNS 프로세스가 일시적으로 꼬였거나, 재시작만으로 해결될 문제는 아니라는 뜻이었다. 그렇다고 이 시점에서 CoreDNS 자체를 완전히 배제할 수는 없었다.

그래서 DNS 요청이 CoreDNS까지 가는 과정에서 막히는지, 아니면 CoreDNS가 요청을 받은 뒤 외부 DNS로 전달하는 과정에서 막히는지부터 나눠보기로 했다.

DNS 쿼리의 전체 흐름을 다시 정리해보았다.
```
BuildKit Pod
↓ nameserver 10.96.0.10 (CoreDNS Service ClusterIP)

kube-proxy iptables (DNAT)
↓ ClusterIP → CoreDNS Pod IP

CoreDNS Pod
↓ 외부 도메인이면 upstream DNS로 forward

upstream DNS
```

크게 보면 확인할 구간은 두 곳이었다.
```
BuildKit Pod
      ↓
[ Service / kube-proxy ]
      ↓
CoreDNS Pod
      ↓
[ upstream으로 가는 경로 ]
      ↓
외부 DNS
```
먼저 위쪽, 즉 Service와 kube-proxy를 거쳐 CoreDNS Pod까지 도달하는 경로부터 확인하기로 했다.

Service를 통하지 않고 CoreDNS Pod IP에 직접 DNS 쿼리를 보내면, Service ClusterIP와 kube-proxy의 DNAT 과정을 한꺼번에 우회할 수 있다.  

#### 검증

이번에는 **Service를 거치지 않고 CoreDNS Pod IP로 직접 쿼리**했다. 이 방식이면 Service ClusterIP와 kube-proxy의 DNAT 과정을 우회할 수 있다. 여기서도 timeout이 발생한다면 문제는 그 앞단이 아니라 CoreDNS Pod까지 가는 네트워크 경로나 그 이후에 있다고 볼 수 있다.

```bash
$ for ip in $(kubectl -n kube-system get pods -l k8s-app=kube-dns \
              -o jsonpath='{.items[*].status.podIP}'); do
    echo "=== $ip ==="
    kubectl run probe-$RANDOM --rm -i --image=busybox:1.36 \
      --restart=Never -- nslookup -timeout=3 auth.docker.io $ip
  done
```

![](/images/posts/buildkit-dns-timeout/07.png)

#### 결과

CoreDNS Service를 우회하고 각 CoreDNS Pod IP에 직접 쿼리했지만 timeout이 발생했다.

적어도 Service ClusterIP나 kube-proxy의 DNAT 과정만의 문제는 아니라는 것을 확인할 수 있었다. 문제 범위는 **Pod에서 CoreDNS Pod까지의 네트워크 경로, CoreDNS 자체의 처리, 또는 CoreDNS에서 upstream DNS로 나가는 경로** 중 하나로 좁혀졌다.

다만 이 테스트에서 사용한 probe Pod는 매번 새로 생성했기 때문에 어느 노드에 배치됐는지를 고정하지 않았다. 따라서 이 결과만으로 특정 노드 간 Pod 통신 장애까지 확정할 수는 없었다.

다음으로 Kubernetes의 Pod 간 통신을 담당하는 Calico의 라우팅 상태를 확인하기로 했다.

### 2.4 네 번째 의심 - Calico 라우팅? (기각)

#### 가설

Kubernetes에서는 Calico 같은 CNI 플러그인이 Pod의 네트워크 인터페이스와 노드 간 통신 경로를 구성한다. KoDeploy는 Calico를 사용하고 있으며, Calico는 각 노드가 다른 노드의 Pod CIDR로 패킷을 전달할 수 있도록 라우팅 정보를 구성한다.

만약 이 라우팅 정보가 제대로 구성되지 않았다면, 각 노드의 라우팅 테이블에서 다른 노드의 Pod CIDR로 가는 경로가 없거나 잘못되어 있을 가능성이 있다. 그래서 먼저 각 노드의 라우팅 테이블을 확인했다.

#### 검증

```bash
ssh worker1 “ip route | grep 192.168”
ssh worker2 “ip route | grep 192.168”
ssh master “ip route | grep 192.168”
```

![](/images/posts/buildkit-dns-timeout/08.png)



#### **결과**

각 노드의 Pod CIDR로 가는 경로는 정상적으로 존재했다. 따라서 “Calico가 노드 간 Pod 경로 자체를 만들지 못했다”는 가설은 기각할 수 있었다.

다만 라우팅 테이블에 경로가 있다는 것과 실제 패킷이 그 경로를 따라 전달된다는 것은 다른 문제다. ip route는 어디로 보내야 하는지를 보여줄 뿐, 중간에서 패킷이 drop되지 않는다는 것까지 보장하지 않는다.

### 2.5 진짜 원인 - 클라우드 VNIC의 anti-spoofing

**라우팅 테이블이 존재한다는 것과 패킷이 실제로 전달된다는 건 다른 문제**이기에 `ip route`는 "경로가 있다"만 보장하고, 그 경로로 패킷이 통과하는가?에 대한 별도 검증이 필요했다.

라우팅 테이블이 존재해도 패킷이 실제로 전달되지 않을 수 있다. 가장 기본 도구인 **`ping` 으로 확인하였다**

**1. master에서 worker의 Pod IP로 ping**

![](/images/posts/buildkit-dns-timeout/09.png)

**2. master에서 worker의 Node IP로 ping**

![](/images/posts/buildkit-dns-timeout/10.png)

같은 worker 노드를 향했지만 목적지 주소에 따라 결과가 갈렸다. worker의 Node IP에는 도달했지만 Pod IP에는 도달하지 못했다. 즉 노드 자체로 가는 경로는 살아 있었고, Pod IP를 사용하는 경로에서 패킷이 어딘가에서 drop되고 있었다.

#### 가설

다만 ping 비교만으론 "어디서" drop됐는지는 모른다. master outbound, OCI 인프라, worker VNIC, worker OS, Pod 자체까지 가능한 drop 지점이 너무 많았고 OCI VNIC 동작에 대한 지식이 부족한 상태라 막혔다

Claude에게 현재 흐름과 ping 결과를 설명하고 가설을 받았고 **anti-spoofing이라는 키워드**를 얻은 뒤 OCI 공식 문서를 통해 좀 더 자세히 확인해보기로 하였다

> [오라클 클라우드 공식문서 - Virtual Network Interface Cards (VNICs)](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingVNICs.htm)
> 
> 
> "By default, every VNIC performs the source/destination check on its network traffic. The VNIC looks at the source and destination listed in the header of each network packet. If the VNIC isn't the source or destination, then the packet is dropped."
> 
> "If the VNIC needs to forward traffic (for example, if it needs to perform Network Address Translation (NAT)), you must disable the source/destination check on the VNIC." 
> 
> "기본적으로 모든 VNIC는 네트워크 트래픽에 대해 source/destination 검사를 수행한다. VNIC는 각 네트워크 패킷 헤더의 source와 destination을 확인하고, VNIC가 source도 destination도 아니면 패킷이 drop된다." 
> 
> "VNIC가 트래픽을 forward해야 하는 경우 (예: NAT를 수행해야 하는 경우), VNIC의 source/destination check를 비활성화해야 한다."
> 

#### 검증

anti-spoofing의 가설이 현재 상황과 딱 맞아떨어졌기에 곧장 바로 테스트를 진행해보았다

해결의 핵심은 **VNIC가 source/destination이 자신의 Node IP와 일치하지 않는 패킷을 drop한다면**, Pod 패킷을 Node IP를 가진 패킷으로 캡슐화했을 때 통과할 것이라는 점이었다. 이를 빠르게 검증하기 위해 Calico의 `ipipMode`를 사용했다.

#### Calico ipipMode — 캡슐화 옵션

Calico는 노드 간 Pod 트래픽을 전달할 때 IPIP 캡슐화를 사용할 수 있다.

KoDeploy에서 사용 중이던 `ipipMode`는 `CrossSubnet`이었고, 모드별 동작은 다음과 같다.

| 모드 | 동작 |
| --- | --- |
| `Never` | IPIP 캡슐화를 사용하지 않음 |
| `Always` | 노드 간 Pod 트래픽을 항상 IPIP로 캡슐화 |
| `CrossSubnet` | 서로 다른 서브넷의 노드 간 트래픽만 캡슐화하고, 같은 서브넷에서는 native routing 사용 |

KoDeploy의 모든 노드는 같은 프라이빗 서브넷(`10.0.0.0/16`)에 있었다.

따라서 현재 구성에서는 노드 간 Pod 트래픽이 IPIP로 캡슐화되지 않고, Pod IP를 source/destination으로 가진 패킷이 그대로 노드 사이를 이동하고 있었다.

문제는 OCI VNIC의 source/destination check였다.

OCI 문서대로라면 VNIC는 패킷의 source와 destination을 확인하고, VNIC 자신이 source나 destination이 아닌 패킷을 drop한다.

그렇다면 Pod IP가 그대로 노출되는 native routing에서는 패킷이 차단될 수 있지만, **Pod 패킷을 Node IP를 가진 패킷 안에 캡슐화하면 VNIC를 통과할 수 있을 것**이라는 가설을 세웠다.

이를 빠르게 검증하기 위해 Calico의 `ipipMode`를 `Always`로 변경하기로 했다.

| 구분 | 변경 전 (native routing) | 변경 후 (IPIP 캡슐화) |
| --- | --- | --- |
| **패킷 헤더** | src: 192.168.219.10<br>dst: 192.168.235.152<br>(Pod IP) | outer src: 10.0.2.21<br>outer dst: 10.0.2.23<br>(Node IP)<br>inner: 기존 Pod 패킷 |
| **VNIC 관점** | source / destination이 Node VNIC의 IP와 일치하지 않음 | outer source / destination이 각 Node VNIC의 IP와 일치 |
| **예상 결과** | source/destination check에 의해 drop | VNIC 통과 |

IPIP를 적용하면 원래의 Pod 패킷은 그대로 유지하면서, 바깥에 Node IP를 source/destination으로 갖는 새로운 IP 헤더를 붙인다.

```text
변경 전 - native routing

src: Pod A IP
dst: Pod B IP
        ↓
      OCI VNIC
        ↓
Pod IP가 그대로 노출
        ↓
source/destination check
        ↓
drop
```

```text
변경 후 - IPIP

원본 Pod 패킷
src: Pod A IP
dst: Pod B IP

        ↓ IPIP encapsulation

outer src: Node A IP
outer dst: Node B IP
inner     : 원본 Pod 패킷

        ↓
      OCI VNIC
        ↓
목적지 Node 도착
        ↓
IPIP decapsulation
        ↓
목적지 Pod로 전달
```

목적지 worker 노드에 패킷이 도착하면 outer header를 제거하고, 내부에 들어 있던 원래 Pod 패킷을 목적지 Pod로 전달한다.

실제로 다음과 같이 `ipipMode`를 `Always`로 변경했다.

```bash
kubectl patch ippool default-ipv4-ippool --type=merge \
  -p '{"spec":{"ipipMode":"Always","vxlanMode":"Never"}}'
```

![](/images/posts/buildkit-dns-timeout/11.png)

![](/images/posts/buildkit-dns-timeout/12.png)

변경 직후 이전에 실패하던 **Pod IP ping이 정상적으로 응답했고, DNS 쿼리도 정상화됐다. BuildKit 빌드 역시 다시 정상적으로 동작했다.**

#### 결과

IPIP 적용 전에는 캡슐화되지 않은 cross-node Pod 트래픽이 실패했지만, Node IP를 outer header로 사용하는 IPIP를 적용하자 동일한 통신이 정상화됐다.

앞서 확인한 OCI 공식 문서의 VNIC source/destination check 동작도 현재 증상과 일치했다.

즉 기존에는 다음과 같은 흐름이었다.

```text
Calico CrossSubnet
        ↓
같은 서브넷으로 판단
        ↓
IPIP 캡슐화 없이 native routing
        ↓
Pod IP가 그대로 노드 사이를 이동
        ↓
OCI VNIC source/destination check
        ↓
drop
```

반대로 IPIP를 적용하면 다음과 같이 바뀐다.

```text
Pod 패킷
        ↓
Node IP로 IPIP encapsulation
        ↓
OCI VNIC 통과
        ↓
목적지 노드에서 decapsulation
        ↓
Pod에 전달
```

따라서 이번 장애는 **Calico의 native Pod routing과 OCI VNIC의 source/destination check가 충돌하면서 cross-node Pod 트래픽이 차단된 것**으로 판단했다.

## 3. 해결 방안 비교

원인은 확인했지만, 검증을 위해 적용한 `ipipMode=Always`가 반드시 최종 해결책일 필요는 없었다.

결국 같은 문제를 **어느 레이어에서 해결할 것인가**의 선택이었다.

1. **Calico IPIP Always** — Kubernetes 레이어에서 Pod 트래픽을 캡슐화
2. **OCI `skip_source_dest_check`** — 인프라 레이어에서 VNIC의 source/destination check 비활성화

두 방법의 trade-off를 비교한 뒤 KoDeploy에 더 적합한 방식을 선택하기로 했다.

#### 옵션 1 - Calico IPIP `Always` (K8s 레이어)

검증 과정에서 적용했던 방식이다.

```bash
kubectl patch ippool default-ipv4-ippool --type=merge \
  -p '{"spec":{"ipipMode":"Always","vxlanMode":"Never"}}'
```

최종적으로 사용한다면 수동 명령으로 남겨두는 대신 Ansible Playbook에 포함해 클러스터 재구축 시에도 동일한 설정이 적용되도록 할 수 있다.

| 장점 | 단점 |
| --- | --- |
| Kubernetes 레이어에서 바로 적용 가능 | 노드 간 Pod 트래픽에 IPIP 캡슐화 오버헤드 발생 |
| OCI 인프라 설정을 변경하지 않아도 됨 | 같은 서브넷의 노드 간 통신도 캡슐화 |
| Kubernetes 권한만으로 적용 가능 | MTU를 고려해야 함 |
| 특정 클라우드의 VNIC 설정에 직접 의존하지 않음 | OCI의 source/destination check 자체는 그대로 유지 |


#### 옵션 2 - Terraform skip_source_dest_check (인프라 레이어)

```
resource "oci_core_instance" "kodeploy_nodes" {
  create_vnic_details {
    skip_source_dest_check = true
  }
}
```

OCI VNIC 단의 anti-spoofing을 끄는 방식

Calico는 기본값 CrossSubnet으로 되돌릴 수 있다.

| 장점 | 단점 |
| --- | --- |
| native 라우팅 사용 가능 (캡슐화 오버헤드 없음) | terraform 변경 + apply 필요 |
| 인프라 차원의 영구 해결 | OCI VNIC 보안 정책을 끄는 거라 부담 |
|  | 벤더 종속 - 클라우드 이전 시 각 벤더의 특성에 맞게 재적용 필요 가능성 |

#### 결정

순수 성능만 보면 Terraform skip이 더 효율적이다 (캡슐화 오버헤드 없음)
하지만 이번 결정엔 KoDeploy의 미래 방향이 더 큰 영향을 끼쳤다

KoDeploy는 현재 지인들에게 제공하는 PaaS 단계이지만, 추후 오픈소스화를 계획하고 있다 (오픈소스 개발자 대회 참여 + 추가 학습 효과) 
처음부터 오픈소스 버전과 웹 버전을 나누기보다는 어느 정도 **오픈소스를 가정하고 만드는 게 남은 시간에 놓치는 게 적을 것**이라 판단해서 OKE 매니지드(Oracle Container Engine for Kubernetes)도 쓰지 않고 self-managed로 구성한 상태다.

오픈소스가 되려면 특정 벤더에 종속되어선 안 된다. 또한 향후 지원금을 받거나 특정 클라우드 사용이 요구되는 환경에 들어갈 경우 다른 클라우드로 이전 운영할 가능성도 열어둬야 한다고 생각했다

그래서 인프라 레이어에 종속되기보다는 **어떤 환경에서든 Ansible로 동일하게 적용 가능한 Calico IPIP Always**를 선택했다.

캡슐화 오버헤드는 KoDeploy의 현재 규모에선 측정 가능한 수준이 아니다. 트래픽이 증가하거나 성능 측정이 필요한 시점에 옵션 2로 마이그레이션을 다시 고민할 수 있다.

**Ansible 영구화**
```yaml
- name: Calico Installation CR 생성 (IPIP Always for OCI)
  copy:
    dest: /tmp/calico-installation.yaml
    content: |
      apiVersion: operator.tigera.io/v1
      kind: Installation
      metadata:
        name: default
      spec:
        calicoNetwork:
          ipPools:
            - blockSize: 26
              cidr: {{ pod_cidr }}
              encapsulation: IPIP    ← 핵심
              natOutgoing: Enabled
              nodeSelector: all()
```

## 4. 회고

### 4.1 다른 클라우드들은 어떤가?

이번 사건의 본질은 **K8s overlay Network의 가정 vs 클라우드 VPC의 anti-spoofing 정책 충돌**이다. AWS위주로 쓰던 나는 다른 클라우드들은 어떤가? OCI만의 문제일까? 라는 생각이 들었다

| 클라우드 | 옵션 이름 | 기본값 | 의미 |
| --- | --- | --- | --- |
| **OCI** | `skip_source_dest_check` | false | 검사 수행 |
| **AWS** | `source_dest_check` | true | 검사 수행 |
| **GCP** | `canIpForward` | false | forward 금지 (= 검사 수행) |
| **Azure** | `enableIPForwarding` | false | forward 금지 (= 검사 수행) |

찾아보니 옵션 이름의 방향이 다 다르지만 (skip / check / canForward / enableForwarding),
옵션 이름과 구현 방식에는 차이가 있지만, 주요 클라우드들은 **기본적으로 VM이 자신의 주소가 아닌 트래픽을 임의로 forwarding하는 것을 제한하는 방향의 정책**을 두고 있었다.

일반 VM에서는 합리적인 기본값이지만, self-managed Kubernetes처럼 노드가 Pod 트래픽을 forwarding하는 구성에서는 CNI의 네트워크 방식과 충돌할 수 있다.

이렇게 설정한 이유는 보안으로 **한 인스턴스가 다른 인스턴스 IP로 위장 (spoofing)하는 걸 막기 위한 정책이다.** 일반 VM이 NAT, 라우터, 방화벽 같은 forward 역할을 잘 안 하니까 기본적으로 켜두는 게 맞다. 근데 K8s 노드는 본질적으로 Pod 트래픽을 forward하는 구조라 이 정책과 충돌한다

KoDeploy는 OKE 매니지드(Oracle Container Engine for Kubernetes)를 안 쓰고 self-managed로 구성해서 이 충돌을 마주친 것으로 매니지드의 자동 관리 편리함을 포기한 대가다. 다만 오픈소스화 같은 미래 옵션을 열어두는 결정이었고 K8s 네트워크 내부를 직접 디버깅하며 배운 것도 많아서 나쁘지 않은 트레이드오프라고 생각한다.

이 문제 패턴 자체가 **K8s self-managed 운영자가 마주치는 산업 표준 패턴**이라는 걸 이번에 배웠다.


### 4.2 그럼 GitHub은 왜 됐었나

이 과정을 진행하면서 느꼈던 의문이 있었다 **"왜 같은 Pod에서 실행했는데 GitHub은 잘 받아오고 docker.io만 안 됐나?"**

처음에는 DNS 캐시 차이 때문에 GitHub만 우연히 풀린 것이 아닐까 의심했다. 하지만 이 가설만으로는 확정할 수 없었다. 이후 같은 프로세스에서 여러 도메인을 연속 조회했을 때 이번에는 반대로 github.com이 timeout되고 auth.docker.io가 성공하면서, 특정 도메인의 캐시 여부보다는 요청마다 통신 경로가 달라지는 현상임을 확인했다.

단계별로 문제를 해결한 후, GitHub 의문의 진짜 원인도 자연스럽게 풀렸다

#### 결정적 단서 - 같은 sh에서 3개 도메인을 연속 쿼리

![](/images/posts/buildkit-dns-timeout/13.png)

```bash
$ sh -c 'nslookup github.com; nslookup auth.docker.io; nslookup registry-1.docker.io'
nslookup github.com           → ;; connection timed out
nslookup auth.docker.io       → 풀림 (Cloudflare CNAME 응답)
nslookup registry-1.docker.io → ;; connection timed out
```

같은 sh 프로세스, 같은 resolver, 같은 nameserver(10.96.0.10), 거의 동시에 그런데 세 도메인 중 가운데만 풀리고 양쪽은 timeout이다.

**심지어 이번엔 docker.io가 풀리고 github.com이 안 됐다.** 처음 디버깅에서 본 패턴과 반대다

캐시 hit으로는 설명되지 않는 패턴이였고 캐시 hit이었다면 일관되게 풀리거나 일관되게 안 풀려야 한다. **매 쿼리마다 결과가 갈린다 = 매번 라우팅이 다르게 결정되고 있다**는 뜻이다.

#### 진짜 답 - kube-proxy의 random DNAT

CoreDNS는 K8s 기본 구성에서 replica로 2개가 떠있는 상태이다

```bash
coredns-...gnglw   master   192.168.219.x   (master 노드)
coredns-...t5vtr   worker   192.168.235.x   (worker 노드)
```

Pod에서 DNS 쿼리하면:

```python
BuildKit Pod (worker)
↓ nameserver 10.96.0.10 (CoreDNS Service ClusterIP)
kube-proxy iptables의 random DNAT
↓ 매 쿼리마다 50:50으로 분배
┌──────────────────┐    ┌──────────────────┐
│ master CoreDNS  │    │ worker CoreDNS │
│ (cross-node)    │    │ (same-node)    │
└──────────────────┘    └──────────────────┘
```

**kube-proxy DNAT는 매 쿼리마다 다시 50:50으로 결정**한다. 같은 Pod에서 연속으로 두 번 쿼리해도 서로 다른 CoreDNS Pod로 갈 수 있다.

BuildKit Pod이 worker 노드에 떴으니:

- **same-node CoreDNS로 가면** (worker CoreDNS) → 노드 내부 통신 →
VNIC 안 거침 → 통과
- **cross-node CoreDNS로 가면** (master CoreDNS) → 노드 간 통신 →
VNIC anti-spoofing drop → timeout

즉 매 DNS 쿼리마다 동전 던지기를 실행하여 **확률적 실패**였다. 

의문은 풀었고 실패였지만 그 덕분에 문제를 미리 알 수 있었어서 운이 좋았다고 생각한다

### 4.3 돌이켜보니 - Failed watch도 같은 이유였다

2.2에서 본 CoreDNS "Failed to watch" 로그도 같은 anti-spoofing이 만든 증상이었다. 처음엔 OOM 연쇄작용으로 인한 CoreDNS 자체 문제로 의심하고 재부팅을 시도했지만 사실은

```yaml
worker 노드의 CoreDNS Pod
→ Kubernetes API Service로 watch 요청
→ kube-proxy를 통해 control plane의 API Server endpoint로 전달
→ worker Pod IP를 source로 가진 cross-node 패킷 발생
→ OCI VNIC source/destination check와 충돌
→ Failed to watch
```

처음엔 다른 문제로 생각했지만, **본질적인 원인 하나가 여러 증상을 만든 것이었다**
CoreDNS Failed to watch, BuildKit DNS timeout, Pod IP ping 100% loss
모두 같은 anti-spoofing의 결과물이었다

## 5. 배운점

#### 1. 비교 검증으로 가설을 좁히는 게 좋다

비교군을 포함한 검증이 디버깅의 핵심인 거 같다. Pod IP vs Node IP ping, github vs
auth.docker.io vs registry-1.docker.io 동시 쿼리하여 하나의 검증으로 여러가지 가설에 대한 결과를 내도록 설계하는 것이 좋다

#### 2. 라우팅 존재 ≠ 패킷 도달

`ip route`는 "갈 길이 있다"만 보장한다 가끔씩 망각하고 “그냥 통과 되겠네” 하고 생각하는데 ping으로 실제 통과 여부를 별도 검증해야 한다.

#### 3. 확률적 실패 패턴 인식

첫 문제 결과를 보고 github.com은 되고 docker.io는 안 되는 "되는 것"과 "안 되는 것"이 명확히 갈리는 듯 보여도 사실 kube-proxy random DNAT 같은 K8s 컴포넌트들이 매번 동전 던지기를 할 수 있으니 정신차려야 한다

#### 4. AI 시대 디버깅의 3단계

항상 느끼는 거지만 AI말만 믿으면 빠르게 풀릴 때가 있어도 생각하지 않으면 아예 안 풀릴 때도 많은거 같고 상황이 복잡할수록 더더욱 그런 거 같다.

항상 너무 AI를 믿고 그대로 받지 않고 검증하는 것이 핵심이며 AI만 믿게되면 어느 순간부턴 AI한테 뇌를 의탁하게 되는 거 같고 경계해야할 거 같다 

#### 5. 클라우드 인프라 충돌은 산업 표준 패턴

OCI만의 문제만은 아니었다 K8s overlay 네트워크와 클라우드 anti-spoofing의 충돌은 self-managed K8s 운영자가 마주치는 일반적 패턴일 거 같다

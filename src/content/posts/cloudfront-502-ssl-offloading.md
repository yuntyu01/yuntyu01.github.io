---
title: "HTTPS가 항상 정답은 아니었다 – CloudFront 502 장애 분석"
date: "2026-01-24"
description: "CloudFront 뒤 ALB 구간의 502를 openssl로 추적해 SNI 불일치를 찾고, SSL Offloading으로 풀었습니다."
tags: ["AWS", "CloudFront", "TLS"]
velog: "https://velog.io/@yun60/HTTPS가-항상-정답은-아니었다-CloudFront-502-장애-분석-0cdd8v8"
thumbnail: "/images/thumbs/cloudfront-502-ssl-offloading.webp"
---
## 1. 배경

Spring Boot 기반의 백엔드 서비스를 AWS ECS(EC2)에 배포하고, 앞단에 CloudFront와 ALB를 두는 아키텍처를 Terraform으로 구축했습니다

- **Tech Stack:** Java 17, Spring Boot 3.x, AWS ECS, ALB, CloudFront, Terraform
- **Architecture:** User(App) ↔ CloudFront (HTTPS) ↔ ALB ↔ ECS (Private Subnet)
![](/images/posts/cloudfront-502-ssl-offloading/01.png)

`terraform apply`가 성공적으로 끝나고 설레는 마음으로 도메인에 접속했으나, 돌아온 것은 **502 Bad Gateway** 에러였습니다.

~~사실 사이에 자잘한 많은 오류가 있었습니다~~

![](/images/posts/cloudfront-502-ssl-offloading/02.png)


## 2. 문제 상황 및 디버깅 전략

### 문제 상황

- CloudFront 도메인으로 접속 시: `502 Bad Gateway` 에러 발생

### 디버깅 전략

보통 `502 Bad Gateway`는 게이트웨이(CloudFront)가 뒷단(Origin)으로부터 유효한 응답을 받지 못했다는 뜻입니다. 이론적으로 백엔드가 아예 죽었으면 `503 Service Unavailable`이 떠야 합니다.

**하지만 에러 코드만 보고 "백엔드는 절대 아닐 거야"라고 단정 짓는 것은 위험하다고 판단했습니다.**

CloudFront는 Origin과 연결 과정에서 발생하는 다양한 문제 (**연결 실패, TLS handshake 실패, timeout  등**)뿐만 아니라, 백엔드가 비정상적으로 종료되거나 연결을 끊어버려도 `502`가 뜰 수도 있기 때문입니다. 

무엇보다 복잡하게 인프라 설정을 파헤치기 전에, **‘딸깍’으로** **확인하기 쉬운 '백엔드 서버 생존’부터 확실하게 검증하여 변수를 하나씩 지워나가는 소거 전략**이 좋을 것이라 판단했습니다

### 디버깅 과정

- **가설 1:** 백엔드(Spring Boot)가 죽었나?
    - **검증:** ALB DNS(`example-lb-xxxxxxx.ap-northeast-2.elb.amazonaws.com`)로 직접 접속 시도
    - **결과:** **200 OK (정상 화면 뜸)**
    - **판단:** ECS, Docker, Spring Boot, Target Group, ALB까지는 **모두 정상이다.** (애플리케이션 문제는 아님)
- **가설 2:** CloudFront 자체에 문제가 있나?
    - **검증:** CloudFront를 통해 배포된 S3 정적 파일(`/static/test.png`) 접속 시도
    - **결과:** **200 OK (이미지 잘 뜸)**
    - **판단:** CloudFront 서버 자체, DNS 연결, ACM 인증서는 **정상이다.**
- **결론:**
    - 양쪽 끝단은 모두 정상이다
    - **CloudFront와 ALB 사이의 연결 구간에 문제가 있다**

## 3. 핵심 원인

앞선 소거법을 통해 양쪽 끝단(CloudFront, Backend)은 정상임을 확인했습니다. 남은 가능성은 **CloudFront와 ALB 사이의 통신 링크**, **HTTPS 연결 과정(TLS Handshake)**라고 생각했습니다

이를 눈으로 확인하기 위해 네트워크 디버깅을 시작했습니다.

### 3-1. 도구 선택 및 검증 전략

웹 브라우저나 `curl` 은 핸드셰이크 과정을 구체적으로 보여주지 않기에 이번 문제를 디버깅하는데 적합하지 않다고 생각하여 **“TCP 3handshake 결과와 TLS 핸드셰이크 과정”**을 보여주는 `openssl` 을 사용하여 CloudFront 입장에서 ALB에 접속을 시도해보았습니다

- **테스트 대상:** ALB DNS 주소 (`example-lb-xxxxxxx.ap-northeast-2.elb.amazonaws.com`)
- **검증 포인트:** TCP handshake가 정상 완료인지, ALB가 어떤 인증서를 내미는지, 그리고 그 인증서가 유효한지 확인

### 3-2. OpenSSL을 통한 디버깅

CloudFront는 Origin에 접속할 때 기본적으로 Origin의 도메인 주소를 Host로 사용합니다. 이 상황을 재현하기 위해 ALB의 DNS 주소로 `openssl` 요청을 보냈습니다.
![](/images/posts/cloudfront-502-ssl-offloading/03.png)

명령어를 실행하자 **결정적인 단서**를 발견할 수 있었습니다

```bash
[root@DESKTOP ecs]# openssl s_client -connect example-lb-xxxxxxx.ap-northeast-2.elb.amazonaws.com:
443 -showcerts
Connecting to 3.38.81.6
CONNECTED(00000003) <- [TCP 3-Way Handshake 성공]
...
depth=0 CN=api.example.com <- [문제 발견]
verify return:1
...
```

### 3-3. 로그 분석 및 원인 확정: SNI 불일치

로그를 분석해 보니 **CloudFront가 요청한 주소와 ALB가 제시한 신분증이 달랐습니다.**

1. **CloudFront (Client Hello):** "나는 `example-lb-xxxx...amazonaws.com`에 접속하고 싶어." (SNI 전송)
2. **ALB (Server Hello):** "그래? 내 신분증(인증서)은 `api.example.com`이야." (ACM 인증서 제시)
3. **결과:** **Host Name Mismatch (신원 불일치)**

`openssl` 로그의 `CONNECTED` 메시지를 통해 TCP 연결은 정상이었으나, 그 이후 **TLS 핸드셰이크 단계에서 인증서 도메인이 일치하지 않아** CloudFront가 연결을 신뢰할 수 없다고 판단하고 502 에러를 반환한 것입니다.

**[설정 원인]**
이 문제는 제가 "내가 보안 전문가는 아니지만 보안은 다다익선이지"이라는 생각으로 CloudFront 오리진 요청을 HTTPS (`https-only`)로 설정했기 때문에 발생했습니다.

**Terraform**

```hcl
resource "aws_cloudfront_distribution" "cdn" {
	...
  origin {
    domain_name = var.alb_dns_name
    origin_id   = "ALB-Origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only" <--- [문제 원인]
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
}
```

CloudFront는 ALB의 DNS 주소를 부르는데, ALB는 커스텀 도메인용 인증서만 가지고 있으니 서로 대화가 통하지 않았던 것입니다. 이를 해결하려면 ALB에 기본 DNS용 인증서를 추가하거나 호스트 헤더를 변조해야 하는데, 이는 복잡도를 불필요하게 높이는 방식이었습니다.

## 4. 해결책

502 에러(SNI 불일치)를 해결하기 위해 저는 3가지 방법을 두고 고민했습니다. 단순히 에러를 없애는 것을 넘어, **운영 효율성**과 **성능**까지 생각한 아키텍처를 찾고자 했습니다.

### 4-1. 기술적 대안 비교

**A. SSL Offloading (선택안)**

- **설명:** CloudFront와 ALB 사이를 HTTP(80) 평문으로 통신하여 암호화 부하를 줄임
- **장점:** TLS 핸드셰이크 제거로 **Latency 약 67% 개선**, 인증서 관리 불필요
- **Risk:** 구간 평문 전송 ➔ **Security Group, Prefix List 격리**로 보안 보완 가능

**B. HTTPS (정석 보안)**

- **설명:** Origin용 서브도메인을 별도 생성하여 전 구간 HTTPS 통신 유지
- **장점:** 높은 수준의 보안 컴플라이언스 준수
- **Risk:** TLS Handshake 오버헤드로 인한 성능 저하, 추가적인 도메인/인증서 관리 비용

**C. Host Header 변조 (우회책)**

- **설명:** CloudFront에서 전달하는 Host 헤더를 실제 도메인으로 강제 치환
- **장점:** 인프라 설정 변경 없이 즉시 적용 가능
- **Risk:** 리다이렉트 문제, 하드코딩으로 인한 확장성 문제, 쿠키 문제

**[의사결정 근거]**

- **옵션 C**는 사이드 이펙트 위험이 커서 배제했습니다.
- **옵션 B**가 정석적인 보안 방식이지만, 현재 프로젝트는 금융/의료 수준의 컴플라이언스가 요구되지 않았기에 성능 향상을 위해 선택하지 않았습니다
- 따라서 **관리 복잡도를 낮추고 성능 이점**을 갖는 **SSL Offloading**를 선택했습니다

### 4-2. 해결책: SSL Offloading 적용

SSL Offloading은 CloudFront가 암호화된 트래픽을 복호화한 뒤, **AWS 내부망을 통해 ALB에게 HTTP로 전달**하는 방식입니다.

- **해결 핵심:** HTTP 통신은 **TLS 핸드셰이크(인증서 검증) 과정 자체가 생략**되므로, 앞서 발생했던 SNI 불일치 문제를 근본적으로 회피할 수 있습니다.
![](/images/posts/cloudfront-502-ssl-offloading/04.png)


### 4-3. 성능 검증: 진짜 HTTP가 더 빠를까?

해결책을 고민하는 과정에서 “HTTP가 HTTPS랑 성능 차이가 유의미한 정돈가?”라는 의문이 들었습니다.

이를 검증하기 위해 **실제 CloudFront 통신 환경과 유사한 AWS 내부망(CloudShell)**에서 테스트를 하였습니다"

> **CloudShell을 쓴 이유**
로컬 환경에서는 ISP의 네트워크 지터로 인해 정확한 Origin Latency를 측정하기 어려웠습니다 따라서 AWS Global Backbone을 타는 CloudShell 환경에서 테스트하여 신뢰도를 높였습니다
> 

**[테스트 결과]**
![](/images/posts/cloudfront-502-ssl-offloading/05.png)


- **테스트 조건:** 동일한 ALB에 대해 `HTTPS(TLS 1.2)` vs `HTTP(1.1)` 요청 100회 수행
- **HTTPS (Before):** 평균 0.0157 sec
- **HTTP (After):** 평균 0.0051 sec
- **결과:** **Latency 약 67% 개선 (3배 속도 향상)**

테스트 데이터를 통해 **SSL Offloading이 단순히 에러 해결책일 뿐만 아니라, 서비스 응답 속도를 평균 15.7ms → 5.1ms로 성능을 약 67% 높여주는 최적화 기법**임을 확인하고 코드에 적용했습니다

※ 본 테스트는 동일 ALB에 대한 HTTP/HTTPS 직접 요청 비교이며, 실제 CloudFront–Origin 통신에서는 연결을 재사용할 수 있으므로 이 차이가 모든 요청에 동일하게 적용되는 것은 아닙니다.

**Terraform 코드수정**

```bash
resource "aws_cloudfront_distribution" "cdn" {
	...
  origin {
    domain_name = var.alb_dns_name
    origin_id   = "ALB-Origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # https-only -> http-only 
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
}
```

**이 설정을 적용하자마자 502 에러가 사라지고 서비스가 정상적으로 동작했습니다**
![](/images/posts/cloudfront-502-ssl-offloading/06.png)


## 5. 보안


“Cloudfront <-> ALB 구간이 평문으로 전송돼서 중간에 누가 패킷을 스니핑할 수 있지않을까?”

아키텍처를 변경하면서 가장 크게 고민했던 부분은 **패킷 스니핑**에 대한 걱정이였습니다 

하지만 AWS 백서를 찾아보며 계층별 보안 메커니즘을 통해 다음과 같은 걱정을 완화 할 수 있었습니다

- **물리적 전송 보안:** CloudFront와 리전 데이터 센터를 잇는 물리적 링크는 AWS가 직접 관리하며, AWS는 AWS 글로벌 네트워크에서 리전 간 전송 트래픽이 물리 계층에서 자동 암호화됩니다. 이를 통해 전송 구간에서의 하드웨어 레벨 도청 위협을 차단합니다.
>https://docs.aws.amazon.com/whitepapers/latest/logical-separation/encrypting-data-at-rest-and--in-transit.html

- **논리적 테넌트 격리:** AWS 백서에서는 VPC 네트워크에서 패킷 흐름이 규칙에 따라 검증되어 전달되고, ARP 스푸핑은 매우 가능성이 낮으며, promiscuous mode로도 고객 OS 트래픽 외 노출이 제한된다라고 합니다 따라서 다른 테넌트가 네트워크 중간에서 트래픽을 엿보는 공격은 현실적으로 매우 어렵다고 판단했습니다. 
> https://docs.aws.amazon.com/whitepapers/latest/logical-separation/vpc-and-accompanying-features.html
- **진입 구간 통제:** **AWS Managed Prefix List**를 활용해 보안 그룹에서 오직 CloudFront의 IP 대역만 허용함으로써, 외부의 직접적인 HTTP 접근을 원천 봉쇄했습니다

**결론적으로,** 위 통제와 AWS 문서 근거를 바탕으로 리스크를 완화하면서도, TLS 핸드셰이크 제거로 응답 속도를 67% 개선하는 구성이 현재 프로젝트의 목표(관리 복잡도↓, 성능↑)에 더 적합하다고 판단하였습니다

### AWS Managed Prefix List 활용

ALB가 HTTP(80) 포트를 열어두더라도, **아무나 접속할 수 없도록** 보안 그룹에서 `0.0.0.0/0`(전체 허용)을 제거하고, **오직 CloudFront의 IP 대역에서 오는 트래픽만 허용**하도록 설정했습니다. AWS는 이를 위해 `Managed Prefix List`를 활용했습니다

** Terraform 적용 코드 **

```hcl
# 1. AWS가 관리하는 CloudFront IP 리스트 데이터 가져오기
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# 2. ALB 보안 그룹에 적용
resource "aws_security_group" "alb_sg" {
  ...
  ingress {
    from_port = 80
    to_port   = 80
    protocol  = "tcp"
    # 삭제: cidr_blocks = ["0.0.0.0/0"] 
    # 추가: 오직 CloudFront IP만 통과 가능
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
}
```

## 6. **운영 관점**

문제를 해결하고 난 후 운영 관점에서 **재발(휴먼에러)방지**를 위해 T**erraform에 주석**을 추가하였습니다 구축 과정에서 발생한 문제라 모니터링에 대한 필요성을 크게 느끼지 못했지만 다른 **`5xx error`** 의 빠른 조치에 도움이 되기에 ~~겸사겸사~~  **모니터링 설정을 추가**하였습니다

- Terraform 주석 작성:
    - 휴먼에러 방지로 인해 https가 아닌 http를 쓰는 이유를 코드에 주석 작성
![](/images/posts/cloudfront-502-ssl-offloading/07.png)
- CloudWatch Alarm 설정**:**
    - Metric: `CloudFront > 5xxErrorRate`

## 7. 결론 및 회고

단순히 502 에러를 고치는 과정이었지만, 이를 통해 **SSL Offloading**의 실질적인 가치(성능 67% 개선)과 **계층적 보안**의 중요성을 배웠습니다

1. **무조건적인 보안(HTTPS)이 꼭 정답은 아니다**
    
    처음에는 "보안은 다다익선"이라는 생각으로 내부 통신까지 HTTPS를 고집했습니다. 하지만 이는 불필요한 인증서 관리 비용과 인증서 불일치로 인한 설정 복잡도만 높였습니다.
    구간별 특성에 맞춰 **적절한 프로토콜(HTTP, HTTPS)을 선택하는 것**이 성능과 유지보수성, 그리고 시스템의 안정성을 모두 잡는 방법임을 배웠습니다.
    
2. **보안은 아키텍처와 함께 완성된다**
    
    프로토콜 암호화도 중요하지만 Security Group과 Prefix List를 활용한 **네트워크 격리**가 더 좋은 결과를 가져올 수 있다라는 걸 깨달았습니다
    
3. **IaC는 편리하고 강력하다**
    
    Terraform을 사용한덕분에 AWS가 관리하는 CloudFront IP 대역이 변경되도 코드가 알아서 최신 정보를 가져오고(`data source`) 적용해주고 모든 걸 코드로 관리함으로써 인프라 상태를 한 눈에 파악할 수 있다는 점과 휴먼 에러를 방지한다는 점이 IaC를 써야하는 이유임을 다시 한 번 느낀 거 같습니다 
    

---

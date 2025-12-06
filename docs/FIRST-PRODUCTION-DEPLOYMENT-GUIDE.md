# Pong Pong 첫 Production 배포 가이드

이 문서는 배포를 처음 해보는 사람이 `Pong Pong`을 인터넷에 안전하게 공개하기 위한 프로젝트 맞춤 절차입니다.

작성 기준은 다음과 같습니다.

- 기준 브랜치: `main`
- 기준 커밋: `6dd868c577a7d503baae3d1e13fe29146f136dbb`
- 확인일: 2026-08-31
- 애플리케이션: Next.js App Router + Fastify + WebSocket + PostgreSQL
- 현재 공개 진입점: Caddy 단일 origin
- 현재 실행 단위: `caddy`, `web`, `api`, `migrate`, `db`

이 문서의 명령과 화면 이름은 작성 시점의 공식 문서를 기준으로 합니다. 실제 결제 전에 각 서비스의 현재 가격과 화면 문구를 다시 확인합니다.

## 먼저 알아둘 가장 중요한 결론

현재 저장소는 **검증 가능한 공개 게스트 체험판**과 **회원형 Production 제품**의 준비 상태가 다릅니다.

- `demo` 모드: 별도 계정 없이 게스트 PvP와 AI 경기를 제공할 수 있습니다. 첫 공개 대상으로 권장합니다.
- `production` 모드: 개발 로그인과 게스트 로그인을 모두 닫지만 OAuth·OIDC 같은 실제 로그인 수단이 없습니다. 지금 배포하면 새 사용자가 회원 기능에 들어갈 수 없습니다.

따라서 첫 배포 목표는 아래 중 하나를 명시적으로 선택해야 합니다.

- [ ] **A. 공개 게스트 데모** — 이 가이드로 준비를 계속할 수 있음
- [ ] **B. 회원형 Production 제품** — 인증 구현과 보안 검토가 끝날 때까지 배포 중지

둘을 동시에 선택하지 않습니다. 이 문서의 기본 경로는 **A. 공개 게스트 데모**입니다.

> **STOP — 회원형 Production**
>
> 현재 `APP_MODE=production`에서는 새 사용자가 session을 만드는 경로가 없습니다. 웹은 비회원 화면에서 개발 로그인 UI를 보여줄 수 있지만 API는 `/auth/dev-login`을 열지 않습니다. 인증 공급자, callback, 계정 연결, logout·프로필 UI와 보안 검토가 완료되기 전에는 `APP_MODE=production`을 사용자에게 공개하지 않습니다.

## 이 문서의 표시법

- **직접 수행**: 계정, 결제, 도메인, 비밀값처럼 소유자가 직접 결정합니다.
- **Codex와 수행 가능**: 저장소 코드·설정·테스트·배포 선언 파일을 함께 준비할 수 있습니다.
- **STOP**: 충족하지 못하면 다음 단계로 넘어가지 않습니다.
- **기록**: 나중에 장애 복구에 필요한 값을 비밀이 아닌 운영 기록에 남깁니다.

비밀번호, database URL, session secret, deploy hook URL은 문서·이슈·채팅·스크린샷에 넣지 않습니다.

## 권장 배포 구조

첫 배포에는 다음 조합을 권장합니다.

```text
사용자 브라우저
  │  HTTPS / WSS
  ▼
Cloudflare DNS·proxy (선택적 보호 계층)
  │
  ▼
Render Web Service: pong-pong-gateway (Caddy, 공개)
  ├─ /, Next asset ───────▶ Render Private Service: pong-pong-web
  ├─ /api/* ──────────────▶ Render Private Service: pong-pong-api
  ├─ /ws ─────────────────▶ Render Private Service: pong-pong-api
  └─ /api/metrics ────────▶ 404
                                  │
                                  ▼
                         Render PostgreSQL 16
                         (회원형 제품에서는 필수)
```

### 이 조합을 선택한 이유

- 현재 Caddy가 HTTP, WebSocket과 웹을 같은 origin으로 묶고 `/api/metrics`를 공개 차단합니다.
- Render는 WebSocket, private service, private network, Docker monorepo와 managed PostgreSQL을 지원합니다.
- API의 경기방·매칭 queue·게스트 제한 상태가 한 프로세스 메모리에 있으므로 API는 **정확히 1개 instance**만 실행해야 합니다.
- Render의 shutdown delay를 `70초 이상`으로 설정하면 저장소의 최대 60초 room drain 계약보다 길게 둘 수 있습니다.
- Cloudflare는 애플리케이션 실행기가 아니라 DNS·TLS·proxy 계층으로만 사용합니다.

### Vercel 단독 배포를 기본값으로 삼지 않는 이유

이 프로젝트는 Next.js 화면만 있는 정적 사이트가 아닙니다. 장시간 연결되는 Fastify WebSocket 서버, 프로세스 메모리의 경기방 상태, 별도 migration과 PostgreSQL이 함께 필요합니다. 서버리스 함수 중심으로 쪼개면 현재의 단일 API scheduler와 room ownership 계약이 달라집니다.

### 단일 VPS + Docker Compose를 기본값으로 삼지 않는 이유

현재 Compose topology와 가장 비슷하고 월 비용이 낮아질 수 있다는 장점은 있습니다. 그러나 첫 배포자가 직접 OS 보안 update, firewall, Docker daemon, disk, PostgreSQL backup·복원, TLS, process 재시작과 장애 대응을 모두 책임져야 합니다. 이 프로젝트는 실시간 연결과 database를 함께 운영하므로, 초보자의 첫 공개에는 managed service가 더 안전한 기본값입니다.

VPS는 운영 경험이 생긴 뒤 비용과 제어권을 위해 다시 비교할 수 있습니다. 그때도 Production database를 단일 Docker volume에만 두지는 않습니다.

### Redis를 만들지 않는 이유

현재 코드에는 Redis client, queue 또는 공유 room-state adapter가 없습니다. Render Key Value나 별도 Redis를 만들어도 애플리케이션이 사용하지 않습니다. 첫 배포에서 캐시를 임의로 추가하지 않습니다.

## 현재 저장소 준비도

### 이미 준비된 부분

- [x] Node.js `24.18.1`과 pnpm `10.32.1` 고정
- [x] API·web production Dockerfile과 non-root 실행
- [x] `pnpm-lock.yaml` 기반 고정 설치
- [x] PostgreSQL migration 6개와 migration-set readiness 검사
- [x] `/health/live`, `/health/ready`, `/metrics`
- [x] Caddy에서 `/api/metrics` 공개 차단
- [x] 서버 권위형 경기 simulation과 단일 결과 확정
- [x] WebSocket heartbeat와 브라우저 재연결 시도
- [x] `SIGTERM` 수신 시 최대 60초 경기방 drain
- [x] Compose `stop_grace_period: 70s`
- [x] HTTP·WebSocket·브라우저·PostgreSQL·Compose CI 작업 정의
- [x] 애플리케이션 logger의 cookie·authorization·query·ticket redaction
- [x] `demo`의 게스트 생성·ticket·연결 수 제한

### 배포 전에 해결해야 하는 STOP

- [ ] 원격 저장소가 연결되어 있지 않습니다. 현재 `git remote -v` 결과가 비어 있습니다.
- [ ] README가 가리키는 `docs/operations.md`, `docs/architecture.md`, `docs/protocol.md`, `docs/development.md`, `docs/case-study.md`, `tests/load/guide.ko.md`가 현재 tracked tree에 없습니다.
- [ ] Render용 `render.yaml` 또는 동등한 검토 가능한 배포 선언이 없습니다.
- [ ] Caddy upstream이 Compose 이름 `api:4000`, `web:3000`으로 고정되어 Render private hostname을 받을 수 없습니다.
- [ ] public gateway, private web/API가 동일 commit을 사용한다는 자동 검증이 없습니다.
- [ ] Render private service의 TCP health와 gateway의 downstream readiness를 묶은 배포 검증이 없습니다.
- [ ] gateway의 `/api/health/ready`는 API·database만 확인하며 Next.js 화면까지 확인하지 않습니다. `/`와 readiness를 각각 감시할 외부 probe가 필요합니다.
- [ ] Cloudflare → Render → Caddy → Fastify proxy chain에서 실제 client IP가 안정적으로 전달되는지 검증되지 않았습니다. guest cookie의 IP binding과 rate limit이 이 값에 의존합니다.
- [ ] Caddy·Next.js의 Production security header 정책과 production CORS allowlist가 별도 계약으로 고정되지 않았습니다.
- [ ] WebSocket query의 일회용 ticket이 Render·Cloudflare platform log에 어떤 형태로 남는지 확인한 운영 결정이 없습니다.
- [ ] 외부 uptime 알림과 내부 `/metrics` 수집·알림 경로가 확정되지 않았습니다.
- [ ] Production database 복원 연습 기록이 없습니다.
- [ ] `main` 기준 최신 부하·장애 주입 결과와 허용 동시 사용자 수가 확정되지 않았습니다.
- [ ] 회원형 제품에는 실제 인증과 완성된 브라우저 사용자 흐름이 없습니다.

> **STOP — 지금은 Dashboard에 값을 추측해 입력하지 않습니다.**
>
> 먼저 위 항목 중 배포 adapter, CI trigger, log 경계, health·rollback 계약을 저장소 변경으로 고정하고 검증해야 합니다. 현재 Docker Compose가 로컬에서 통과한다는 사실만으로 Render 구성이 자동으로 생기지는 않습니다.

## 0단계 — 출시 범위와 비용을 먼저 적기

### 0-1. 공개 범위

**직접 수행**

- [ ] 출시 이름을 `Pong Pong 공개 게스트 데모`로 기록했습니다.
- [ ] 게스트 경기 결과는 전적·순위표에 저장되지 않는다는 점을 사용자에게 표시합니다.
- [ ] dashboard, leaderboard, tournament, profile, admin은 demo에서 숨겨지는 것을 확인했습니다.
- [ ] 최대 동시 사용자 수를 임의로 광고하지 않습니다.
- [ ] 서비스 재배포·platform maintenance 중 진행 중인 경기가 끊길 수 있음을 운영상 수용했습니다.

코드의 기본 guest 한도는 전체 연결 200, IP당 4이지만 이 값은 보장 처리량이 아닙니다. 실제 공개 한도는 부하 검증 결과로 정합니다.

### 0-2. 결제 항목

Render Dashboard와 [공식 가격표](https://render.com/pricing)를 열어 실제 월 예상액을 기록합니다.

| 항목 | 게스트 데모 | 회원형 제품 | 선택·월 예상액 |
| --- | --- | --- | --- |
| Render workspace | Hobby 또는 Pro 검토 | Pro 우선 검토 |  |
| public Caddy Web Service | paid compute | paid compute |  |
| private Next.js service | paid compute | paid compute |  |
| private Fastify API service | paid compute | paid compute |  |
| Render PostgreSQL | 선택 | paid 필수 |  |
| database storage·backup | DB 사용 시 | 필수 |  |
| Cloudflare | Free부터 검토 | 요구사항에 맞게 |  |
| domain 등록·갱신 | 필수 | 필수 |  |
| 외부 uptime monitor | 권장 | 필수 |  |

무료 web instance는 비활성 시 잠들 수 있으므로 즉시 응답과 지속적인 WebSocket이 필요한 공개 게임의 운영 기준으로 사용하지 않습니다. 무료 PostgreSQL에는 Production 복구 계약이 없습니다. 유료 PostgreSQL은 PITR와 논리 export를 제공합니다.

### 0-3. 리전

- [ ] 주 사용자가 한국이면 Render `Singapore`를 선택합니다.
- [ ] gateway, web, API, database를 모두 같은 리전에 만듭니다.
- [ ] 생성 뒤에는 리전을 직접 변경할 수 없으므로 결제 전에 다시 확인합니다.

## 1단계 — 저장소의 배포 계약을 먼저 완성하기

이 단계는 **Codex와 수행 가능**합니다. 다음 결과가 하나의 검토 가능한 작업 단위로 준비되어야 합니다.

- [ ] `.github/workflows/...`가 실제 배포 branch인 `main`의 PR과 push를 검사합니다.
- [ ] `render.yaml`이 public gateway, private web, private API와 선택적 PostgreSQL을 선언합니다.
- [ ] 모든 Docker build context는 monorepo root를 사용합니다.
- [ ] API Dockerfile은 `apps/api/Dockerfile`, web은 `apps/web/Dockerfile`, gateway는 `Caddy.Dockerfile`을 사용합니다.
- [ ] Caddyfile이 검증된 환경변수로 private upstream을 받습니다.
- [ ] Caddy가 `/api/metrics`를 계속 404로 막습니다.
- [ ] API는 public service가 아니라 private service이고, `TRUST_PROXY=1`을 임의의 public client header에 노출하지 않습니다.
- [ ] 실제 Cloudflare·Render proxy chain으로 HTTP와 WebSocket의 client IP·guest IP binding을 검증합니다.
- [ ] production CORS에는 실제 `WEB_ORIGIN`만 허용하고 localhost 개발 origin을 운영 경로에서 제외합니다.
- [ ] HSTS, content sniffing, framing, referrer와 필요한 CSP를 검토해 gateway 응답 header 계약으로 고정합니다.
- [ ] gateway health check가 `/api/health/ready`를 사용합니다.
- [ ] API shutdown delay가 최소 70초입니다.
- [ ] API instance count는 1입니다.
- [ ] web build에 공개 URL과 mode가 명시적으로 들어갑니다.
- [ ] database migration은 API의 paid pre-deploy command에서 정확히 한 번 실행됩니다.
- [ ] demo 첫 배포에는 seed를 실행하지 않습니다.
- [ ] 배포용 정적 계약 테스트가 service topology, secret 분리, health, metrics 차단과 shutdown delay를 검사합니다.
- [ ] 문서가 가리키는 누락 운영 문서를 복구하거나 README의 잘못된 링크를 정리합니다.

배포 adapter가 확정되기 전의 **의도**는 다음과 같습니다. 이 문자열을 현재 Dashboard에 그대로 복사하지 말고 구현·테스트가 끝난 `render.yaml`을 기준으로 입력합니다.

| 서비스 | 유형 | 핵심 계약 |
| --- | --- | --- |
| `pong-pong-gateway` | Web Service, Docker | Caddy, public domain, readiness proxy |
| `pong-pong-web` | Private Service, Docker | Next standalone, final public URLs at build time |
| `pong-pong-api` | Private Service, Docker | Fastify + WS, 1 instance, migration, 70초 이상 shutdown |
| `pong-pong-db` | Render Postgres 16 | 회원형 필수, 같은 region, internal URL |

### 1-1. 배포 전 필수 검증

새 배포 adapter가 포함된 commit에서 다음이 모두 성공해야 합니다.

```sh
make install
make check
make postgres-integration

POSTGRES_PASSWORD=synthetic-compose-password \
SESSION_SECRET=synthetic-compose-session-secret-32-bytes \
APP_MODE=demo \
PUBLIC_ORIGIN=https://pong.invalid \
PUBLIC_WS_URL=wss://pong.invalid/ws \
make compose-config
```

마지막 명령의 값은 Compose interpolation만 검증하는 폐기 가능한 합성값이다. 실제 Production secret이나
domain을 local 검증에 복사하지 않는다. `.invalid`는 공개 DNS로 사용할 수 없는 예약 suffix이므로 이
명령 외의 배포 설정에는 사용하지 않는다.

그다음 폐기 가능한 로컬 database로 Compose smoke와 guest-demo E2E를 실행합니다.

Production credential이나 Production database를 이 검증에 사용하지 않습니다.

### 1-2. CI 결과

- [ ] `main` 대상 PR에서 verify 성공
- [ ] PostgreSQL integration 성공
- [ ] HTTP·WebSocket·browser 성공
- [ ] guest-demo browser 성공
- [ ] production Compose 성공
- [ ] 모든 job이 동일 commit SHA를 검사함

## 2단계 — 계정과 소유권 준비

### 2-1. GitHub

**직접 수행**

- [ ] 개인 계정에 2단계 인증을 켰습니다.
- [ ] 이 프로젝트용 private repository를 만들었습니다.
- [ ] repository 관리자와 비상 복구 담당자를 기록했습니다.
- [ ] `main` 삭제와 force push를 제한했습니다.
- [ ] CI 필수 check가 성공해야 merge되도록 branch protection을 설정했습니다.
- [ ] secret scanning·Dependabot 알림 사용 여부를 확인했습니다.

현재 로컬에는 remote가 없습니다. remote 생성·최초 push는 소유자가 정확한 대상 repository를 확인한 뒤 별도 작업으로 수행합니다.

**기록**

| 항목 | 값 |
| --- | --- |
| GitHub repository |  |
| 기본 branch | `main` |
| 첫 배포 commit 전체 SHA |  |
| CI run URL |  |

### 2-2. Render

**직접 수행**

- [ ] Render account를 만들고 GitHub 계정을 연결했습니다.
- [ ] account 2FA를 켰습니다.
- [ ] `pong-pong` project를 만들었습니다.
- [ ] `production` environment를 만들었습니다.
- [ ] 팀 운영이면 protected environment와 관리자 범위를 검토했습니다.
- [ ] 결제 수단과 월 지출 알림을 설정했습니다.
- [ ] deploy failure·unhealthy 알림을 email 또는 Slack으로 받습니다.

### 2-3. Cloudflare와 domain

**직접 수행**

- [ ] 사용할 domain을 등록했습니다.
- [ ] 등록자 account와 Cloudflare account에 2FA를 켰습니다.
- [ ] domain 자동 갱신과 결제 실패 알림을 켰습니다.
- [ ] 기존 MX·TXT·CAA record를 내보내 안전하게 보관했습니다.
- [ ] 앱 hostname을 결정했습니다. 예: `pong.example.com`

상표·domain 선택은 사람의 법적·브랜드 판단입니다. 가이드가 사용 가능성을 보증하지 않습니다.

## 3단계 — 환경변수와 비밀값 설계

### 3-1. 공개 hostname

아래 예시의 `pong.example.com`을 실제 hostname으로 한 번만 치환합니다.

| 변수 | 공개 게스트 데모 값 |
| --- | --- |
| `APP_MODE` | `demo` |
| `NEXT_PUBLIC_APP_MODE` | `demo` |
| `WEB_ORIGIN` | `https://pong.example.com` |
| `NEXT_PUBLIC_API_BASE_URL` | `https://pong.example.com/api` |
| `NEXT_PUBLIC_WS_URL` | `wss://pong.example.com/ws` |
| `TRUST_PROXY` | `1` |
| `API_PORT` | 배포 adapter에서 고정한 private port |
| `LOG_LEVEL` | `info` |

`NEXT_PUBLIC_*`는 browser bundle에 포함되는 공개 설정입니다. 여기에 secret을 넣지 않습니다. 값이 바뀌면 web image를 다시 빌드해야 합니다.

`TRUST_PROXY=1`은 API가 private network 안에서 검증된 gateway 요청만 받을 때만 허용합니다. API를 public service로 바꾸면 client가 전달 header를 위조해 IP 기반 guest 제한을 우회할 수 있으므로 배포를 중지합니다.

### 3-2. `SESSION_SECRET`

**직접 수행**

로컬 terminal에서 안전한 무작위 값을 생성할 수 있습니다.

```sh
openssl rand -base64 48
```

- [ ] 출력값을 Render의 `pong-pong-api` secret field에만 붙여넣었습니다.
- [ ] `.env`, README, issue, chat 또는 screenshot에 복사하지 않았습니다.
- [ ] gateway와 web에는 이 값을 주지 않았습니다.
- [ ] password manager에 용도와 생성일만 안전하게 기록했습니다.

이 값을 바꾸면 기존 guest cookie와 등록 session이 무효가 됩니다. 회전은 maintenance window와 사용자 공지 뒤에 수행합니다.

### 3-3. 서비스별 최소 권한

| 값 | gateway | web | API | migration |
| --- | :---: | :---: | :---: | :---: |
| public hostname | 필요 | 필요 | 필요 | 불필요 |
| private web upstream | 필요 | 불필요 | 불필요 | 불필요 |
| private API upstream | 필요 | 불필요 | 불필요 | 불필요 |
| `NEXT_PUBLIC_*` | 불필요 | 필요 | 불필요 | 불필요 |
| `SESSION_SECRET` | 금지 | 금지 | 필요 | 금지 |
| `DATABASE_URL` | 금지 | 금지 | DB 사용 시 필요 | 필요 |

Render가 Docker environment 값을 build arg로도 제공할 수 있으므로 secret을 Dockerfile `ARG`로 선언하지 않습니다.

## 4단계 — PostgreSQL 만들기

공개 guest demo에서 경기 결과는 저장하지 않으므로 database는 기능상 선택입니다. 다음 조건이면 처음부터 PostgreSQL을 만듭니다.

- 곧 회원 인증을 붙일 계획임
- migration·readiness·backup 운영을 첫날부터 검증하려 함
- 운영 비용을 수용함

database 없이 demo를 공개한다면 API는 memory repository를 사용하며 재시작 후 상태를 잃습니다. 이것은 demo의 임시 경기 정책과 일치하지만 회원형 전환 전에 database를 반드시 추가해야 합니다.

### 4-1. 생성 화면

Render Dashboard에서 **New > Postgres**를 선택합니다.

- [ ] Name: `pong-pong-db`
- [ ] Database: `pong_pong`
- [ ] User: Render가 생성하거나 전용 이름 사용
- [ ] Region: `Singapore`
- [ ] PostgreSQL Version: `16`
- [ ] Compute: Free가 아닌 복구 가능한 paid plan
- [ ] Storage: 초기 사용량과 예산에 맞게 선택
- [ ] Storage autoscaling: 비용 상한을 이해한 뒤 선택

현재 Compose와 CI가 PostgreSQL 16으로 검증되므로 첫 Production database도 16을 사용합니다. 주요 버전 upgrade는 별도 작업입니다.

### 4-2. network

- [ ] API와 database가 같은 Render account·region에 있습니다.
- [ ] API에는 Render의 **internal database URL**만 연결합니다.
- [ ] 외부 IP allow list의 기본 `0.0.0.0/0`을 제거하고 외부 접근을 비활성화합니다.
- [ ] local laptop에서 Production DB에 상시 접속하지 않습니다.

### 4-3. backup

- [ ] Recovery 화면에서 PITR 보존 기간을 확인했습니다.
- [ ] 첫 사용자 데이터 전 logical export를 한 번 생성했습니다.
- [ ] export 보존 기간과 별도 장기 보관 위치를 정했습니다.
- [ ] 분기마다 새 database instance로 PITR 복원 연습을 기록합니다.

> **주의**
>
> Render에서 database를 삭제하면 해당 instance의 backup도 보존되지 않습니다. 복원본 검증과 connection 전환 전에는 기존 database를 삭제하지 않습니다.

## 5단계 — Render service 만들기

이 단계는 1단계의 검증된 `render.yaml`이 준비된 뒤 실행합니다. 가능하면 Dashboard에서 세 서비스를 따로 추측해 만드는 대신 Blueprint로 생성합니다.

### 5-1. 공통 설정

- [ ] 연결 repository와 branch가 정확합니다.
- [ ] 세 서비스가 동일한 full commit SHA를 사용합니다.
- [ ] Region은 모두 `Singapore`입니다.
- [ ] 첫 배포 동안 auto-deploy는 `Off`입니다.
- [ ] Free compute를 선택하지 않았습니다.
- [ ] Production environment 밖의 secret group을 연결하지 않았습니다.

### 5-2. `pong-pong-api`

- [ ] Type: Private Service
- [ ] Runtime: Docker
- [ ] Docker context: repository root
- [ ] Dockerfile: `apps/api/Dockerfile`
- [ ] Instance count: **1**
- [ ] `APP_MODE=demo`
- [ ] `SESSION_SECRET` 설정
- [ ] `WEB_ORIGIN=https://pong.example.com`
- [ ] `TRUST_PROXY=1`
- [ ] `LOG_LEVEL=info`
- [ ] database 사용 시 `DATABASE_URL`은 internal URL
- [ ] migration pre-deploy command는 검증된 adapter 값
- [ ] max shutdown delay는 `70`초 이상

Private Service는 HTTP path health가 아니라 TCP health만 지원합니다. 실제 database·migration readiness는 gateway의 `/api/health/ready`와 외부 monitor가 확인해야 합니다.

### 5-3. `pong-pong-web`

- [ ] Type: Private Service
- [ ] Runtime: Docker
- [ ] Docker context: repository root
- [ ] Dockerfile: `apps/web/Dockerfile`
- [ ] Instance count: 1
- [ ] `NEXT_PUBLIC_API_BASE_URL=https://pong.example.com/api`
- [ ] `NEXT_PUBLIC_WS_URL=wss://pong.example.com/ws`
- [ ] `NEXT_PUBLIC_APP_MODE=demo`

이 세 값은 build 결과에 들어갑니다. `Save and deploy`만으로 runtime 값만 바꾸지 말고 **rebuild**가 일어났는지 확인합니다.

### 5-4. `pong-pong-gateway`

- [ ] Type: Web Service
- [ ] Runtime: Docker
- [ ] Docker context: repository root
- [ ] Dockerfile: `Caddy.Dockerfile`
- [ ] Instance count: 1
- [ ] private web host·port를 검증된 upstream 변수에 연결
- [ ] private API host·port를 검증된 upstream 변수에 연결
- [ ] Health Check Path: `/api/health/ready`
- [ ] `/api/metrics` 응답이 404인지 확인
- [ ] maintenance mode를 사용할 수 있는 paid compute인지 확인

gateway만 public URL을 가집니다. private web과 API에는 custom domain이나 public URL을 만들지 않습니다.

gateway health check 하나만으로 전체 화면을 보장할 수는 없습니다. Render health는 `/api/health/ready`, 외부 uptime monitor는 `/`와 `/api/health/ready` 두 경로를 각각 검사합니다.

## 6단계 — 첫 migration과 seed

### 6-1. migration

database를 사용하는 경우 API의 pre-deploy 단계에서 아래 의도가 실행됩니다.

```sh
node packages/db/dist/cli.js migrate
```

- [ ] migration이 `001_initial`부터 `006_chat_invariants`까지 성공했습니다.
- [ ] `/api/health/ready`의 `migrations`가 `current`입니다.
- [ ] 실패하면 새 API를 공개하지 않고 기존 배포를 유지합니다.
- [ ] 실행 로그에는 database URL이 나타나지 않습니다.

각 migration에는 down 경로가 없습니다. schema를 되돌려야 하는 변경은 code rollback만으로 해결되지 않습니다.

### 6-2. seed

첫 공개 guest demo에는 seed가 필요하지 않습니다.

- [ ] `seed:dev`를 Production database에서 실행하지 않았습니다.
- [ ] `seed:demo`를 필요성 검토 없이 실행하지 않았습니다.
- [ ] guest AI는 API 프로세스 안에서 동작하므로 별도 NPC row를 만들지 않았습니다.

회원형 제품에서는 실제 사용자 생성 후 관리자 bootstrap 절차가 별도로 필요합니다. 현재는 인증 자체가 없으므로 이 단계도 **STOP**입니다.

## 7단계 — custom domain과 TLS 연결

### 7-1. Render에 domain 추가

`pong-pong-gateway`의 **Settings > Custom Domains**에서 앱 hostname을 추가합니다.

- [ ] `pong.example.com`을 추가했습니다.
- [ ] Render가 보여주는 정확한 DNS target을 기록했습니다.
- [ ] 기존 production hostname의 record를 덮어쓰지 않았습니다.

### 7-2. Cloudflare DNS

Cloudflare의 **DNS > Records > Add record**에서 Render가 안내한 record를 만듭니다.

- [ ] 초기 검증 중 Proxy status를 `DNS only`로 두었습니다.
- [ ] Render Dashboard에서 domain verification이 성공했습니다.
- [ ] Render TLS certificate가 발급되었습니다.
- [ ] HTTPS로 직접 접속해 인증서 hostname과 만료 상태를 확인했습니다.
- [ ] Cloudflare SSL/TLS mode를 `Full (strict)`로 설정했습니다.
- [ ] 이후 필요한 경우 Proxy status를 `Proxied`로 전환했습니다.
- [ ] Cloudflare Network의 WebSockets가 켜져 있습니다.

Cloudflare cache rule은 `/api/*`와 `/ws`를 bypass하도록 둡니다. API JSON, cookie 응답과 WebSocket handshake를 cache하지 않습니다.

### 7-3. 우회 주소 닫기

custom domain 검증과 smoke가 끝난 뒤 gateway의 Render subdomain을 비활성화합니다.

- [ ] `pong-pong-gateway > Settings > Custom Domains`
- [ ] `Render Subdomain`을 `Disabled`로 변경
- [ ] 기존 `onrender.com` 주소가 404인지 확인
- [ ] custom domain은 정상인지 다시 확인

## 8단계 — 첫 배포 순서

세 서비스가 서로 다른 commit으로 떠 있는 시간을 만들지 않습니다.

1. [ ] 출시할 full commit SHA를 기록합니다.
2. [ ] 해당 SHA의 GitHub Actions가 모두 성공했는지 확인합니다.
3. [ ] gateway maintenance mode를 켭니다.
4. [ ] database를 사용하는 경우 backup 또는 빈 database 상태를 기록합니다.
5. [ ] API를 **Deploy a specific commit**으로 배포합니다.
6. [ ] migration과 API startup 성공을 확인합니다.
7. [ ] web을 같은 commit으로 rebuild·deploy합니다.
8. [ ] gateway를 같은 commit으로 배포합니다.
9. [ ] `/api/health/ready`가 200인지 확인합니다.
10. [ ] maintenance mode를 잠시 끄고 smoke를 수행합니다.
11. [ ] 실패하면 다시 maintenance mode를 켜고 rollback합니다.
12. [ ] 성공하면 traffic 공개를 승인합니다.

**기록**

| 항목 | 값 |
| --- | --- |
| Release SHA |  |
| API deploy URL |  |
| web deploy URL |  |
| gateway deploy URL |  |
| migration 결과 |  |
| 승인자 |  |
| 공개 시각(KST/UTC) |  |

## 9단계 — 공개 직전 smoke

Production에서 기존 `tests/smoke-api.mjs`와 `tests/smoke-ws.mjs`를 실행하지 않습니다. 두 script는 `/auth/dev-login`을 기대하고 사용자·경기 데이터를 만들기 때문에 demo 또는 Production smoke로 적합하지 않습니다.

### 9-1. HTTP

공개 hostname만 사용합니다.

```sh
curl --fail --silent --show-error https://pong.example.com/ >/dev/null
curl --fail --silent --show-error https://pong.example.com/api/health/live
curl --fail --silent --show-error https://pong.example.com/api/health/ready
curl --silent --output /dev/null --write-out '%{http_code}\n' https://pong.example.com/api/metrics
```

- [ ] `/`가 200
- [ ] `/api/health/live`가 200
- [ ] `/api/health/ready`가 200이고 database·migration 상태가 기대와 일치
- [ ] `/api/metrics`가 404
- [ ] HTTPS가 아닌 요청은 HTTPS로 이동
- [ ] API response나 화면에 내부 hostname·stack trace가 없음

### 9-2. browser

일반 창과 시크릿 창을 각각 열어 서로 다른 guest로 확인합니다.

- [ ] 첫 화면에 `게스트로 시작`이 보입니다.
- [ ] 핸들·표시 이름 입력과 `개발 로그인`이 보이지 않습니다.
- [ ] guest 진입 뒤 navigation은 `로비`, `경기`만 보입니다.
- [ ] 두 창에서 빠른 매칭을 누르면 같은 PvP 방에 들어갑니다.
- [ ] 두 사용자 모두 준비 후 경기가 시작됩니다.
- [ ] 키보드와 touch input이 동작합니다.
- [ ] 한 창만 사용하면 약 6초 뒤 AI 상대가 연결됩니다.
- [ ] 새로고침·일시적인 연결 끊김 후 UI가 오류 상태를 명확히 표시합니다.
- [ ] browser console에 mixed-content, CORS, cookie, WebSocket 오류가 없습니다.
- [ ] Network에서 API는 `https://`, WebSocket은 `wss://`를 사용합니다.
- [ ] dashboard, leaderboard, tournaments, profile, admin 경로는 404입니다.
- [ ] 같은 guest의 HTTP ticket 발급과 WebSocket 연결에서 server가 인식한 client IP가 안정적입니다.

### 9-3. log

- [ ] application log에 cookie, authorization, raw query, WebSocket ticket이 없습니다.
- [ ] Caddy access log를 임의로 켜지 않았습니다.
- [ ] Render와 Cloudflare의 request-log 보존 범위에서 query string이 저장되는지 확인했습니다.
- [ ] ticket query가 저장된다면 보존·접근 제한을 승인하거나 배포를 중지했습니다.
- [ ] 사용자 IP와 user ID를 포함하는 운영 log의 접근자와 보존 기간을 기록했습니다.

## 10단계 — traffic 공개

공개 직전 한 번 더 확인합니다.

- [ ] CI가 release SHA에서 성공
- [ ] 세 서비스가 같은 SHA
- [ ] readiness 200
- [ ] metrics 404
- [ ] custom domain TLS 정상
- [ ] Cloudflare `Full (strict)`
- [ ] WebSocket smoke 정상
- [ ] Render 실패·unhealthy 알림 정상
- [ ] rollback 대상 이전 SHA 기록
- [ ] database backup 시점 기록
- [ ] 담당자가 최소 30분간 상태를 볼 수 있음

그다음에만 maintenance mode를 끄거나 기존 hostname의 DNS를 새 gateway로 전환합니다.

처음 30분 동안 다음을 관찰합니다.

- gateway·web·API 오류율
- `/api/health/ready`
- memory·CPU·event-loop lag
- WebSocket 연결 수와 snapshot drop
- match finalization failure·duplicate
- database connection과 slow query
- guest rate-limit 오류 급증

## 11단계 — 실시간 게임 운영 규칙

### 한 개 API instance

API의 room, queue, guest ticket, connection lease는 프로세스 메모리에 있습니다.

- [ ] API를 2개 이상으로 scale하지 않습니다.
- [ ] autoscaling을 켜지 않습니다.
- [ ] load balancer의 session affinity가 해결책이라고 가정하지 않습니다.
- [ ] 다중 instance가 필요하면 shared room ownership과 state transfer를 먼저 설계합니다.

### 배포와 진행 중 경기

Render는 deploy나 maintenance에서 WebSocket을 종료할 수 있습니다. 현재 client는 짧은 재연결을 시도하지만 새 API 프로세스에는 이전 room state가 없습니다.

- [ ] 가능하면 active room이 0일 때 배포합니다.
- [ ] gateway maintenance mode로 새 match 진입을 막습니다.
- [ ] API가 최대 60초 drain할 수 있게 shutdown delay를 70초 이상 유지합니다.
- [ ] 플랫폼 교체로 경기 복구가 불가능한 경우 사용자에게 재시작 안내를 제공합니다.
- [ ] Cloudflare도 network update 중 WebSocket을 종료할 수 있음을 운영 문서에 포함합니다.

## 12단계 — rollback

### 12-1. code rollback

1. [ ] gateway maintenance mode를 켭니다.
2. [ ] 세 서비스의 현재 SHA와 이전 정상 SHA를 확인합니다.
3. [ ] migration이 이전 code와 호환되는지 확인합니다.
4. [ ] API를 이전 deploy artifact로 rollback합니다.
5. [ ] web을 같은 이전 SHA로 rollback합니다.
6. [ ] gateway를 같은 이전 SHA로 rollback합니다.
7. [ ] readiness와 demo browser smoke를 수행합니다.
8. [ ] 정상일 때만 maintenance mode를 끕니다.

Render rollback은 service별 작업입니다. 한 서비스만 되돌리고 끝내지 않습니다. environment group의 현재 값과 custom domain은 code artifact rollback으로 되돌아가지 않을 수 있습니다.

### 12-2. migration 장애

현재 migration에는 자동 down이 없습니다.

- [ ] migration 실패 시 새 API를 공개하지 않습니다.
- [ ] 적용 전 database backup/PITR 시점을 확인합니다.
- [ ] 이미 데이터가 변경됐다면 code rollback이 안전한지 먼저 검토합니다.
- [ ] schema restore가 필요하면 새 PITR database에 복원합니다.
- [ ] 복원본을 검증한 뒤 `DATABASE_URL`을 전환합니다.
- [ ] readiness가 `current`인 것을 확인합니다.
- [ ] 기존 database는 복원본 검증이 끝날 때까지 삭제하지 않습니다.

### 12-3. DNS rollback

- [ ] 이전 정상 origin의 record 값을 미리 기록합니다.
- [ ] DNS 변경 전 TTL과 전파 시간을 확인합니다.
- [ ] rollback 시 Cloudflare record를 이전 target으로 되돌립니다.
- [ ] TLS, HTTP와 WSS를 모두 다시 확인합니다.

## 13단계 — 반복 운영

### 매일 또는 알림 발생 시

- [ ] gateway와 API health 확인
- [ ] failed deploy·unhealthy 알림 확인
- [ ] 5xx·WebSocket reconnect 급증 확인
- [ ] CPU·memory·database connection 확인
- [ ] guest abuse·rate-limit 급증 확인

### 매주

- [ ] dependency·security alert 검토
- [ ] database storage와 slow query 검토
- [ ] log에 secret·ticket·민감 query가 남지 않는지 표본 확인
- [ ] domain·TLS 알림 상태 확인
- [ ] 사용량과 비용 추세 기록

### 매월

- [ ] current `main`에서 CI 전체 성공 확인
- [ ] rollback 대상 SHA와 담당자 최신화
- [ ] logical database export 생성·보관 검토
- [ ] Render·GitHub·Cloudflare member와 token 정리
- [ ] 공개 화면과 demo 제한 문구 검토

### 분기마다

- [ ] PITR을 새 database로 복원하는 훈련
- [ ] 최신 commit의 부하·장애 주입 재검증
- [ ] WebSocket 끊김·deploy 중 room drain 훈련
- [ ] `SESSION_SECRET` 회전 필요성 검토
- [ ] PostgreSQL major version 지원 일정 검토
- [ ] 회원형 제품으로 전환할지 제품 checkpoint

## 반드시 멈추고 도움을 요청할 상황

다음 중 하나라도 해당하면 추측해서 진행하지 않습니다.

- CI가 release SHA에서 모두 성공하지 않음
- `main`이 CI trigger 대상이 아님
- 세 Render service의 commit SHA가 다름
- `APP_MODE`와 `NEXT_PUBLIC_APP_MODE`가 다름
- production mode를 쓰려는데 실제 로그인 공급자가 없음
- `/api/health/ready`가 503 또는 migration이 `pending`·`diverged`
- `/api/metrics`가 public 200으로 노출됨
- database URL 또는 session secret이 build log·GitHub·문서에 나타남
- Render·Cloudflare log가 raw WebSocket ticket query를 장기 보존함
- API instance가 2개 이상임
- API가 public service인데 `TRUST_PROXY=1`임
- proxy chain에서 client IP가 바뀌거나 임의 header로 위조 가능함
- shutdown delay가 room drain보다 짧음
- deploy 중 진행 중 경기를 안전하게 다룰 담당자가 없음
- Production DB backup 또는 복원 지점이 없음
- migration 적용 뒤 이전 code와 schema 호환성을 모름
- Cloudflare가 `Flexible` 또는 `Full`이고 `Full (strict)`가 아님
- browser에서 `ws://` 또는 `http://` mixed content가 발생함
- 예상치 못한 비용 증가 또는 database storage 부족 알림이 발생함
- 삭제·force push·database restore 대상이 정확하지 않음

## 첫 출시 기록 양식

비밀값을 제외하고 아래 표를 운영 기록에 복사합니다.

| 항목 | 기록 |
| --- | --- |
| 출시 종류 | 공개 guest demo / 회원형 production |
| Git repository |  |
| Release full SHA |  |
| CI run |  |
| Render project/environment |  |
| Region |  |
| gateway/web/API plan |  |
| database major/plan |  |
| custom hostname |  |
| Render domain verification 시각 |  |
| Cloudflare proxy 전환 시각 |  |
| migration 결과 |  |
| backup/PITR 기준 시각 |  |
| HTTP smoke 결과 |  |
| WebSocket demo 결과 |  |
| rollback SHA |  |
| 승인자 |  |
| 다음 점검일 |  |

## 공식 참고 문서

### Render

- [WebSockets on Render](https://render.com/docs/websocket)
- [Private Services](https://render.com/docs/private-services)
- [Private Network](https://render.com/docs/private-network)
- [Monorepo Support](https://render.com/docs/monorepo-support)
- [Docker on Render](https://render.com/docs/docker)
- [Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Deploying on Render](https://render.com/docs/deploys)
- [Rollbacks](https://render.com/docs/rollbacks)
- [Health Checks](https://render.com/docs/health-checks)
- [Environment Variables and Secrets](https://render.com/docs/configure-environment-variables)
- [Create and Connect to Render Postgres](https://render.com/docs/postgresql-creating-connecting)
- [Render Postgres Recovery and Backups](https://render.com/docs/postgresql-backups)
- [Custom Domains](https://render.com/docs/custom-domains)
- [Projects and Environments](https://render.com/docs/projects)
- [Login Settings](https://render.com/docs/login-settings)
- [Notifications](https://render.com/docs/notifications)
- [Pricing](https://render.com/pricing)

### Cloudflare

- [Create DNS records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)
- [Proxy status](https://developers.cloudflare.com/dns/proxy-status/)
- [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
- [WebSockets](https://developers.cloudflare.com/network/websockets/)

## 마지막 확인

이 체크리스트를 위에서 아래로 완료해도 **회원형 Production 제품이 자동으로 완성되지는 않습니다**. 현재 코드로 즉시 공개 가능한 범위는 제한된 guest demo입니다.

- [ ] guest demo 범위를 이해했습니다.
- [ ] 배포 adapter와 CI STOP을 먼저 해결했습니다.
- [ ] 계정·결제·domain·traffic switch는 소유자가 승인했습니다.
- [ ] 실제 secret은 문서나 채팅에 노출하지 않았습니다.
- [ ] release SHA, backup과 rollback을 기록했습니다.
- [ ] 공개 후 담당자가 알림을 받을 수 있습니다.

모든 항목이 확인되었을 때만 공개 트래픽을 엽니다.

PNPM ?= pnpm
COMPOSE ?= docker compose
.DEFAULT_GOAL := install

.PHONY: help install install-update typecheck build unit unit-functional contracts \
	verify-build check postgres-integration smoke smoke-http smoke-ws e2e \
	e2e-guest-demo compose-config dev down clean fclean re

help:
	@printf '%s\n' \
		'Local verification:' \
		'  install              install the exact lockfile dependency graph' \
		'  install-update       install dependencies and allow lockfile updates' \
		'  typecheck            type-check every workspace package' \
		'  unit                 run workspace unit tests' \
		'  unit-functional      run unit tests without documentation policy' \
		'  contracts            run static CI and container contract tests' \
		'  build                 build packages in dependency order' \
		'  verify-build          verify expected production artifacts' \
		'  check                 run the non-container CI verification sequence' \
		'  postgres-integration  run integration tests against PostgreSQL' \
		'' \
		'Runtime verification:' \
		'  smoke                 run HTTP and WebSocket smoke tests in order' \
		'  e2e                   run the Playwright browser suite' \
		'  e2e-guest-demo        run the guest-demo Playwright suite' \
		'' \
		'Compose lifecycle:' \
		'  compose-config        validate the resolved Compose configuration' \
		'  dev                   build and run the Compose stack in foreground' \
		'  down                  stop the stack and remove orphan containers' \
		'' \
		'Cleanup:' \
		'  clean                 remove build artifacts (dist, .next, coverage)' \
		'  fclean                clean, then remove node_modules' \
		'  re                    fclean, then reinstall and rebuild'

install:
	$(PNPM) install --frozen-lockfile

install-update:
	$(PNPM) install

typecheck:
	$(PNPM) typecheck

build:
	$(PNPM) build

unit:
	$(PNPM) unit

unit-functional:
	$(PNPM) unit:functional

contracts:
	$(PNPM) test:contracts

verify-build:
	$(PNPM) verify:build

# [INTV:ARCH] CI의 verify job이 바로 이 타겟 하나를 호출한다(.github/workflows/ci.yml) — 저렴하고
# 빠른 검사부터(typecheck) 점점 비싼 검사로(build) 순서를 배치해, 초반에 이미 실패할 게 뻔한
# 커밋이 뒤쪽의 프로덕션 빌드까지 가지 않고 빨리 끝나게 한다.
check:
	$(MAKE) typecheck
	$(MAKE) unit-functional
	$(MAKE) contracts
	$(MAKE) build
	$(MAKE) verify-build

postgres-integration:
	$(PNPM) postgres-integration

# [INTV:ARCH] HTTP 스모크와 WebSocket 스모크를 하나의 make 타겟으로 묶어 순서를 고정해둔 이유 —
# WS 연결은 보통 HTTP 업그레이드 핸드셰이크를 거치므로, HTTP 서버가 먼저 정상 응답한다는 걸 확인한
# 뒤에 WS를 검사하는 편이 "둘 다 실패했을 때 어느 쪽이 진짜 원인인지" 구분하기 쉽다.
smoke:
	$(MAKE) smoke-http
	$(MAKE) smoke-ws

smoke-http:
	$(PNPM) smoke:http

smoke-ws:
	$(PNPM) smoke:ws

e2e:
	$(PNPM) e2e

e2e-guest-demo:
	$(PNPM) e2e:guest-demo

compose-config:
	$(COMPOSE) config --quiet

dev:
	$(COMPOSE) up --build

down:
	$(COMPOSE) down --remove-orphans

clean:
	rm -rf apps/*/dist apps/*/.next packages/*/dist coverage test-results playwright-report output/playwright
	find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete

fclean: clean
	rm -rf node_modules apps/*/node_modules packages/*/node_modules

re: fclean
	$(PNPM) install --frozen-lockfile
	$(MAKE) build

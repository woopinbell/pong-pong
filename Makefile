.PHONY: install typecheck build test unit contracts smoke smoke-http smoke-ws e2e dev down

install:
	pnpm install

typecheck:
	pnpm -r typecheck

build:
	pnpm -r build

test:
	pnpm unit

unit:
	pnpm unit

contracts:
	pnpm test:contracts

smoke: smoke-http smoke-ws

smoke-http:
	pnpm smoke:http

smoke-ws:
	pnpm smoke:ws

dev:
	docker compose up --build

down:
	docker compose down --remove-orphans

e2e:
	pnpm e2e

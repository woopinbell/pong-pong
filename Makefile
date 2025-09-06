.PHONY: install typecheck build test smoke

install:
	pnpm install

typecheck:
	pnpm -r typecheck

build:
	pnpm -r build

test:
	pnpm -r test

smoke:
	node tests/smoke-api.mjs
	node tests/smoke-ws.mjs

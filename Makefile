.PHONY: install typecheck build test

install:
	pnpm install

typecheck:
	pnpm -r typecheck

build:
	pnpm -r build

test:
	pnpm -r test

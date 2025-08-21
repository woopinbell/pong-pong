.PHONY: install typecheck build

install:
	pnpm install

typecheck:
	pnpm -r typecheck

build:
	pnpm -r build

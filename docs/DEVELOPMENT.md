# Development

```text
docker compose run --build --rm test
docker compose run --rm typecheck
```

`npm test` compiles TypeScript and runs Vitest inside the image. `dist/`
is not written to the checkout. Rebuild when `package.json` or
`package-lock.json` changes. `src/`, `test/`, `demo/`, and `examples/` are
mounted read-only.

Node 18 or newer can run a published build. The test runner in this image
is Node 22. Do not install Node on the host to work in this repository.

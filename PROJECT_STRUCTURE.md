# Project structure

```text
commerce-platform/
├── apps/
│   ├── api-gateway/
│   │   ├── src/
│   │   │   ├── app.controller.spec.ts
│   │   │   ├── app.controller.ts
│   │   │   ├── app.module.ts
│   │   │   ├── app.service.ts
│   │   │   └── main.ts
│   │   ├── test/
│   │   │   └── app.e2e-spec.ts
│   │   ├── .gitignore
│   │   ├── .oxlintrc.json
│   │   ├── .prettierrc
│   │   ├── nest-cli.json
│   │   ├── package.json
│   │   ├── pnpm-lock.yaml
│   │   ├── README.md
│   │   ├── tsconfig.build.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.e2e.ts
│   │   └── vitest.config.ts
│   ├── fulfillment-service/
│   ├── inventory-service/
│   ├── notification-service/
│   ├── order-service/
│   └── payment-service/
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Generated folders and files such as `node_modules/`, `dist/`, coverage output, and
TypeScript build metadata are deliberately omitted because they are ignored by Git.

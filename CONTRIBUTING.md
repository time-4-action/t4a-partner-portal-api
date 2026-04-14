# Contributing

Thanks for your interest in contributing to the Patrik Products Export API! This guide will help you get started.

---

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Install** dependencies: `npm install`
4. **Copy** environment config: `cp .env.development .env`
5. **Run** the dev server: `npm run dev`

---

## Development

```bash
npm run dev       # Start with NODE_ENV=development
npm start         # Start with NODE_ENV=production
```

The API runs on `http://localhost:3000` with all routes under `/api/export`.

### Project Layout

- `src/routes/` -- Route definitions (URL mapping)
- `src/controllers/` -- Request handlers (validation, response shaping)
- `src/services/` -- Business logic (data processing, external API calls)
- `src/middleware/` -- Express middleware (auth, logging, analytics)
- `src/config/` -- External service configurations and field mappings

### Code Style

- CommonJS modules (`require` / `module.exports`)
- Express 5.x patterns
- Async/await for all asynchronous operations
- MongoDB native driver (not Mongoose)

---

## Making Changes

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** -- keep commits focused and atomic

3. **Test locally** -- verify your changes work with `npm run dev`

4. **Push** your branch and open a Pull Request

---

## Pull Request Guidelines

- Keep PRs focused on a single change
- Write a clear description of what changed and why
- Reference any related issues
- Ensure the health endpoint still passes: `GET /api/export/health`

---

## Reporting Issues

Use the GitHub issue templates:

- **Bug reports** -- describe what happened, steps to reproduce, and expected behavior
- **Feature requests** -- describe the problem you're trying to solve and your proposed solution

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

# Contributing to Cavendo Engine

Thank you for your interest in contributing to Cavendo Engine! This document provides guidelines and information for contributors.

## Code of Conduct

Please be respectful and constructive in all interactions. We welcome contributions from everyone regardless of experience level.

## Getting Started

### Prerequisites

- Node.js 18.0 or higher
- npm or yarn
- Python 3.x with setuptools (for native module compilation)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/Cavendo/Engine.git Cavendo-Engine
cd Engine

# Install dependencies
npm install
cd ui && npm install && cd ..

# Initialize the database
node server/db/init.js

# Start development servers
npm run dev
```

This starts:
- API server on http://localhost:3001
- UI dev server on http://localhost:5173

## Project Structure

```
Cavendo-Engine/
├── server/           # Express.js API server
│   ├── routes/       # API route handlers
│   ├── middleware/   # Auth, security middleware
│   ├── services/     # Business logic
│   ├── utils/        # Utilities
│   └── db/           # Database schema, migrations
├── ui/               # React + Vite frontend
│   └── src/
│       ├── components/
│       ├── pages/
│       └── hooks/
├── packages/
│   ├── mcp-server/   # MCP integration
│   └── python-sdk/   # Python client
└── docs/             # Documentation
```

## How to Contribute

### Reporting Bugs

1. Check if the issue already exists
2. Create a new issue with:
   - Clear title describing the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node version, etc.)

### Suggesting Features

1. Open a discussion or issue
2. Describe the use case
3. Explain the proposed solution
4. Be open to feedback and alternative approaches

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Write or update tests if applicable
5. Ensure code passes lint checks
6. **Sign off your commits** (see Developer Certificate of Origin below)
7. Push to your fork
8. Open a Pull Request

#### PR Guidelines

- Keep PRs focused on a single change
- Update documentation for user-facing changes
- Add tests for new functionality
- Follow existing code style
- Respond to review feedback promptly
- All commits must include a `Signed-off-by` line (see below)

## Developer Certificate of Origin (DCO)

All contributions to Cavendo Engine must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). This is a lightweight way to certify that you wrote or otherwise have the right to submit the code you're contributing under the project's license.

By adding a `Signed-off-by` line to your commit messages, you are certifying the following:

> **Developer Certificate of Origin, Version 1.1**
>
> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the right to submit it under the open source license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my knowledge, is covered under an appropriate open source license and I have the right under that license to submit that work with modifications, whether created in whole or in part by me, under the same open source license (unless I am permitted to submit under a different license), as indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person who certified (a), (b) or (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are public and that a record of the contribution (including all personal information I submit with it, including my sign-off) is maintained indefinitely and may be redistributed consistent with this project or the open source license(s) involved.

### How to Sign Off Your Commits

Add the `-s` flag when committing:

```bash
git commit -s -m "Fix task queue race condition"
```

This automatically appends a sign-off line to your commit message:

```
Fix task queue race condition

Signed-off-by: Your Name <your.email@example.com>
```

Make sure your git `user.name` and `user.email` are set correctly:

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### Fixing Unsigned Commits

If you forgot to sign off a commit, you can amend it:

```bash
# Fix the most recent commit
git commit --amend -s --no-edit

# Fix multiple commits (interactive rebase)
git rebase --signoff HEAD~N
```

Where `N` is the number of commits to fix.

### DCO Enforcement

We use an automated DCO check on all pull requests. PRs with unsigned commits will not be merged until all commits include a valid `Signed-off-by` line. The bot will comment on your PR with instructions if any commits are missing sign-off.

## Code Style

### JavaScript/TypeScript

- Use ES6+ features
- Prefer `const` over `let`
- Use meaningful variable names
- Add JSDoc comments for public functions
- Handle errors appropriately

### React

- Use functional components with hooks
- Keep components focused and small
- Use Tailwind CSS for styling
- Follow existing patterns in the codebase

### SQL

- Use parameterized queries (never interpolate user input)
- Add indexes for frequently queried columns
- Use transactions for multi-step operations

## Testing

```bash
# Run tests
npm test

# Run specific test file
npm test -- path/to/test.js
```

## Documentation

- Update docs when changing user-facing features
- Use clear, concise language
- Include code examples where helpful
- Keep API documentation in sync with code

## Questions?

- Open a GitHub Discussion for general questions
- Join our Discord community
- Check existing issues and discussions first

## License

Cavendo Engine is licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0). By contributing to this project, you agree that your contributions will be licensed under the AGPL-3.0.

### Dual Licensing

Cavendo Engine is also available under a commercial license for organizations that need to use the software without the obligations of the AGPL. If you are interested in commercial licensing, please contact us at [sales@cavendo.com](mailto:sales@cavendo.com).

Your contributions under the AGPL remain your copyright. We do not require a Contributor License Agreement (CLA) or copyright assignment. The DCO sign-off simply certifies that you have the right to submit the contribution under the project's license.

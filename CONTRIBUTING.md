# Contributing to XLab Token

Thank you for your interest in contributing to XLab Token! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what is best for the community
- Show empathy towards other community members

## Getting Started

### Prerequisites

- Node.js 20+
- npm or yarn
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/XLab_Token.git
   cd XLab_Token
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```

## Development Workflow

### Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test additions/changes

### Commit Messages

Follow conventional commits format:

```
type(scope): subject

body

footer
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Test changes
- `chore`: Build process or auxiliary tool changes

Example:
```
feat(claude-code): add support for new session format

- Update parser to handle new JSONL format
- Add tests for new format
- Update documentation
```

### Pull Request Process

1. Update documentation if needed
2. Add tests for new features or bug fixes
3. Ensure all tests pass: `npm test`
4. Run type checking: `npm run typecheck`
5. Update CHANGELOG.md
6. Submit a pull request with a clear description

### Code Style

- Use TypeScript for new code
- Follow existing code style
- Add JSDoc comments for public functions
- Keep functions small and focused
- Write meaningful variable names

## Testing

### Running Tests

```bash
npm test
```

### Writing Tests

- Write tests for new features
- Test edge cases
- Keep tests independent
- Use descriptive test names

## Adding New Agent Support

To add support for a new AI agent:

1. Create a new directory in `src/agents/<agent-name>/`
2. Implement the agent module following the `AgentModule` interface
3. Add the agent to the registry in `src/agents/index.ts`
4. Add tests for the new agent
5. Update documentation

## Documentation

### Updating README

- Keep installation instructions up to date
- Document new features
- Update supported agents list
- Add examples for new functionality

### API Documentation

- Update JSDoc comments for public APIs
- Document new endpoints in HTTP API section
- Keep data model documentation current

## Issue Reporting

When reporting issues:

1. Use the issue template
2. Provide clear steps to reproduce
3. Include environment information (OS, Node.js version, etc.)
4. Add relevant logs or error messages
5. Label issues appropriately

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Feel free to open an issue for questions or discussion.

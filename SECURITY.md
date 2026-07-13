# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

### How to Report

**Do not** open a public issue for security vulnerabilities.

Instead, please send an email to: security@xlab.dev

Include the following information:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (if known)

### What to Expect

- You will receive an acknowledgment within 48 hours
- We will provide a detailed response within 7 days
- We will work with you to understand and fix the issue
- You will be credited in the fix (if desired)

### Security Best Practices

This project follows these security practices:

1. **Local-first by default** - Binds to 127.0.0.1 only
2. **No cloud dependencies** - Works offline by default
3. **Minimal data exposure** - Tracks tokens and costs, not full conversations
4. **User-owned data** - All data stored locally under user control
5. **Regular updates** - Dependencies are regularly updated for security patches

### Known Security Considerations

- **Network Exposure**: Do not bind to 0.0.0.0 on untrusted networks
- **Data Sensitivity**: Treat local database as sensitive if workspace paths are stored
- **Third-party Dependencies**: Review dependency updates for security implications

### Dependency Security

We regularly audit and update dependencies. Security updates are prioritized and released as patch versions.

## Security Features

- **Localhost-only binding** by default
- **No account required** - reduces attack surface
- **Prefer counters** - tokens and costs, not full chat content
- **User-controlled data** - all data under user's data directory
- **Explicit network** - optional price-table updates only if enabled

## Contributing Security Fixes

When contributing security fixes:

1. Follow the reporting process above
2. Include clear reproduction steps
3. Provide test cases for the fix
4. Document the security implications
5. Follow responsible disclosure practices

## Security Audits

This project welcomes security audits. Please contact us at security@xlab.dev to coordinate.

## License

Security fixes are licensed under the same MIT License as the project.

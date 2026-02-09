# Contributing to YouTube Downloader

Thank you for considering contributing! 🎉

## How to Contribute

### Reporting Bugs

1. Check if the issue already exists
2. Use the bug report template
3. Include:
   - OS and version
   - Deno version (`deno --version`)
   - Steps to reproduce
   - Expected vs actual behavior
   - Error messages/logs

### Suggesting Features

1. Check if the feature is already requested
2. Open an issue with:
   - Clear use case
   - Expected behavior
   - Why it would be useful

### Pull Requests

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly:
   ```bash
   # Test single video download
   # Test playlist download
   # Test search functionality
   # Test edge cases
   ```
5. Format code:
   ```bash
   deno fmt api.ts
   ```
6. Commit with clear messages
7. Push to your fork
8. Open a PR with:
   - Description of changes
   - Testing performed
   - Screenshots (if UI changes)

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/youtube-downloader-deno.git
cd youtube-downloader-deno

# Install Deno (if needed)
curl -fsSL https://deno.land/install.sh | sh

# Run in dev mode
deno run --allow-all --watch api.ts
```

## Code Style

- Use TypeScript
- Follow existing code patterns
- Add comments for complex logic
- Keep functions focused and small
- Use meaningful variable names

## Testing

Before submitting:

- [ ] Test single video download
- [ ] Test playlist download
- [ ] Test with geo-blocked content
- [ ] Test edge cases (single video with list= param)
- [ ] Test on your target platform
- [ ] Verify cleanup works

## Documentation

- Update README.md if needed
- Add comments for new features
- Update relevant docs in `docs/`

## Questions?

Open a discussion or ask in your PR!

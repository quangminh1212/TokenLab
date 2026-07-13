# Electron Icons

This directory contains the application icons for the XLab Token desktop app.

## Current Icons

- `icon.png` - Linux icon (copied from project logo)
- `icon.svg` - Source SVG (copied from project logo)
- `icon.ico` - Windows icon (needs to be generated)
- `icon.icns` - macOS icon (needs to be generated)

## Icon Generation

The icons are automatically generated from the project logo in `src/server/assets/`.

### Generate Development Icons

```bash
npm run generate-icons
```

This copies the project logo to the required formats for development.

### Generate Production Icons

For production builds, you need to convert the logo to platform-specific formats:

#### Windows (icon.ico)

**Option 1: Online converter**
- Visit https://cloudconvert.com/png-to-ico
- Upload `icon.png`
- Set size to 256x256
- Download `icon.ico`

**Option 2: ImageMagick**
```bash
magick convert icon.png -define icon:auto-resize=256,128,96,64,48,32,16 icon.ico
```

**Option 3: PowerShell (using ImageMagick)**
```powershell
magick convert icon.png -resize 256x256 icon.ico
```

#### macOS (icon.icns)

**Option 1: Online converter**
- Visit https://cloudconvert.com/png-to-icns
- Upload `icon.png`
- Download `icon.icns`

**Option 2: macOS iconutil**
```bash
# Create iconset directory
mkdir icon.iconset
# Generate different sizes
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
# Convert to icns
iconutil -c icns icon.iconset
# Cleanup
rm -rf icon.iconset
```

#### Linux (icon.png)

Linux uses the PNG directly, so no conversion needed:
- `icon.png` is already available from the project logo

## Icon Sources

The icons are derived from the project logo located in `src/server/assets/`:
- `logo.png` - High-resolution PNG logo
- `logo.svg` - Vector SVG logo

## Testing Icons

After generating new icons, test them by running:

```bash
npm run electron:dev
```

The app window should display the new icon in the title bar and taskbar.

## Icon Guidelines

- **Size**: 256x256 pixels minimum
- **Format**: PNG with transparency support
- **Background**: Transparent or solid color matching app theme
- **Contrast**: Ensure good visibility on both light and dark backgrounds
- **Simplicity**: Keep the design clean and recognizable at small sizes

## Troubleshooting

**Icon not showing:**
- Verify the icon file exists in the correct format
- Check that the file name matches the expected format
- On macOS, try removing the icon to use the default Electron icon
- On Windows, ensure the .ico file is valid

**Icon looks blurry:**
- Use a higher resolution source image
- Ensure the icon is properly sized for each platform
- Test the icon at different sizes

**Build fails due to missing icon:**
- Run `npm run generate-icons` to create development icons
- For production, generate the required platform-specific icons
- Or remove icon references from electron-builder config

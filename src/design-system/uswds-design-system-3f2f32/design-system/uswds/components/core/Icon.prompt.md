Inline SVG icon — dependency-free, monochrome, inherits text color and size.

```jsx
<Icon name="search" />
<Icon name="check_circle" color="var(--theme-success-dark)" size={24} />
<Button icon="file_download">Download</Button>  {/* Button/Alert use Icon internally */}
```

USWDS icons are functional and literal — never decorative. They inherit `currentColor`; status icons take the matching `--theme-*` color. Pass `title` only when the icon conveys meaning on its own (otherwise it's hidden from assistive tech). See `ICON_NAMES` for the bundled set.

Primary call-to-action button in the USWDS style — use for form submits, navigation actions, and the main task on a page.

```jsx
<Button variant="default" onClick={handleSubmit}>Start application</Button>
<Button variant="outline" icon="file_download">Download form</Button>
<Button variant="secondary" size="big">Cancel request</Button>
```

Variants: `default` (primary blue), `secondary` (red, destructive/strong), `base` (neutral gray), `accent-cool`, `accent-warm`, `outline` (transparent w/ 2px stroke), `unstyled` (renders as a link). Use `size="big"` for hero/landing CTAs. Pass a Material Icons ligature name to `icon`. Buttons use sentence case, verb-first labels ("Start application", not "Submit"). Hover darkens to the next grade; focus shows the 4px gold ring. One primary button per section.

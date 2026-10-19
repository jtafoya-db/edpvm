Hierarchical navigation trail. The last item renders as the (non-link) current page.

```jsx
<Breadcrumb items={[
  { label: "Home", href: "/" },
  { label: "Benefits", href: "/benefits" },
  { label: "Apply" },
]} />
```

Links underline; separator is a small `navigate_next` chevron. Keep labels short.

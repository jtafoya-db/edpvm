Page navigation for long result lists. Collapses to ellipses past 7 pages.

```jsx
const [page, setPage] = React.useState(1);
<Pagination current={page} total={12} onChange={setPage} />
```

Current page fills with primary blue; Previous/Next show chevrons and disable at the ends.

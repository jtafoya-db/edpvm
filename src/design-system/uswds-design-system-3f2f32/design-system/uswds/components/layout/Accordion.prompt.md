Expandable/collapsible sections for dense content like FAQs.

```jsx
<Accordion
  multiselectable
  defaultOpen={["a"]}
  items={[
    { id: "a", title: "How do I apply?", content: <p>Start the online form…</p> },
    { id: "b", title: "What documents do I need?", content: <p>Bring ID…</p> },
  ]}
/>
```

Header buttons use sans-bold with a rotating `expand_more` chevron and the gold focus ring. `multiselectable` keeps multiple panels open; otherwise opening one closes the rest. Bordered by default.

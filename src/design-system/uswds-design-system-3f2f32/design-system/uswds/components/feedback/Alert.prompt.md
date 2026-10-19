Status messaging banner — tells the user what happened and what to do next.

```jsx
<Alert type="success" heading="Application submitted">
  We'll email you a confirmation within 30 minutes.
</Alert>
<Alert type="error" heading="There is a problem" >
  Enter a date in MM/DD/YYYY format.
</Alert>
<Alert type="info" slim>Your session will expire in 5 minutes.</Alert>
```

Types: `info`, `success`, `warning`, `error`, `emergency`. Each pairs a vivid left rule + tinted background + matching icon. Error/warning use `role="alert"`. Write blame-free, specific copy. Use `slim` for short single-line messages and `noIcon` rarely.

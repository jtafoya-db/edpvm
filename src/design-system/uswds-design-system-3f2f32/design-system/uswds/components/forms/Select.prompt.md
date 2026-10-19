Labelled native dropdown with a custom chevron, matching the text-input styling.

```jsx
<Select label="State" required>
  <option value="">- Select -</option>
  <option>California</option>
  <option>Texas</option>
</Select>
```

Same label/hint/error contract as TextInput. Always include a placeholder first option for required selects.

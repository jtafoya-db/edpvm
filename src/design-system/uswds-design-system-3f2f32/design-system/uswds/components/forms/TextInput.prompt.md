Labelled single-line text field with optional hint and error state.

```jsx
<TextInput label="Email address" type="email" required hint="We'll only use this to contact you." />
<TextInput label="Date of birth" error="Enter a date in MM/DD/YYYY format." width="md" />
```

Labels are sans-bold sentence case; required fields show a red asterisk. Error state adds a 2px red border, a 4px red rule on the group, and a bold error message above the field. Inputs are square (0 radius), 1px base-dark border, gold focus ring. Width presets: sm/md/default/lg/full.

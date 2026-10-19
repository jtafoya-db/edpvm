// Allow importing the checked-in schema config as a module without enabling
// `resolveJsonModule` project-wide. loadSchema() casts it to IntakeSchema.
declare module "*.json" {
  const value: unknown;
  export default value;
}

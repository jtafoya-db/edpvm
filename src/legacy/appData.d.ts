// Ambient declaration for the side-effecting legacy mock-data module.
// src/legacy/appData.js assigns window.AppData on import and exports nothing at
// runtime; this lets TypeScript resolve the side-effect import used in tests.
export {};

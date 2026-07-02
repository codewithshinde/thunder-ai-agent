# Windows Smoke Checklist

Run on Windows with a normal user account.

1. Open `C:\dev\project` in VS Code.
2. Confirm Mitii indexes the workspace without path errors.
3. Ask Mitii to read a file using both `src\foo.ts` and `src/foo.ts`.
4. Stage a change and run `Mitii: Generate Commit Message`.
5. Run `Mitii: Export Audit Pack` and confirm the zip uses forward-slash entries.
6. Add a built-in MCP server and confirm the `cmd /c npx` wrapper starts.
7. Run `npm test` from PowerShell.


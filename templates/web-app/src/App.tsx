import { APITester } from "./APITester";
import "./index.css";

export function App() {
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-10 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2 border-b border-line pb-6">
        <h1 className="text-3xl font-semibold tracking-tight">{{name}}</h1>
        <p className="text-muted">
          Edit <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-sm">src/App.tsx</code> and
          save; the page reloads. Colors, type and spacing live in{" "}
          <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-sm">src/theme.css</code>.
        </p>
      </header>

      <main className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Try the API</h2>
        <APITester />
      </main>
    </div>
  );
}

export default App;

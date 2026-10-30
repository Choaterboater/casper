/** Real-terminal fixture for the hand-over: Casper with the real Pi runtime and a loopback model (the test serves it). */
import { CasperApp } from "../../src/app";
import { folderTrustDefaults } from "../../src/project/trust";

const root = process.argv[2]!;
const app = new CasperApp({ input: process.stdin, output: process.stdout, sessionHomeDir: process.env.HOME });
// As in the test preload: the folder counts as one you trusted, so the screen opens with no "Trust this folder?" box.
folderTrustDefaults.lookup = async (info) => ({ trusted: true, from: info.root });
// Yes to everything: the AI's command runs with no box, so the one-line note is what says it starts.
app.stopAsking = true;
try { await app.runInteractive(root); } finally { await app.close(); }

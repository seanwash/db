import { openClient, planOutput, resolveInvocation } from "./app.ts";
import { helpText, parseCli } from "./cli.ts";
import { captureContext } from "./environment.ts";

const VERSION = "0.1.0";

try {
  const command = parseCli(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(helpText());
  } else if (command.kind === "version") {
    console.log(`db ${VERSION}`);
  } else {
    const plan = resolveInvocation(command.invocation, captureContext());
    console.log(planOutput(plan));
    if (!command.invocation.dryRun) {
      openClient(plan);
    }
  }
} catch (error) {
  if (error instanceof Error) {
    console.error(`db: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

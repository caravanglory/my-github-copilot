import { copilotXCli } from "./cli/copilot-x"

copilotXCli()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })

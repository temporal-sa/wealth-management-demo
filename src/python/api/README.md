# Python API

For a REST API that works with every framework (`/start-workflow`, `/send-prompt`, `/get-chat-history`, `/end-chat`, `/chaos`).

Empty for now. The reference API, `src/python/openai_agents/api`, imports that port's workflow class, `OpenAIAgentsPlugin` and claim-check plugin. To move it here, start the workflow by name (`"WealthManagementWorkflow"`) and move the codec into shared code.

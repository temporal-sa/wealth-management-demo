# React Web App for Wealth Management

An easy to use web based front end for the Wealth Management Agent. 
It uses the [API](../src/python/api/README.md) to interact with Temporal.

## Prerequisites 

[Node.js](https://nodejs.org/en/download): Version 18 or higher, with npm.

The web application relies on the API to communicate with Temporal. 
Be sure to follow the instructions to run the API, which can be found [here](../src/python/api/README.md).
The one API serves every framework, including the TypeScript and Go ones.
Start it for the frameworks whose workers you're running, because that decides which task queue chats start on
and how their workflow IDs are named. Name several separated by commas, or `all`, to chat with each
(see [Several frameworks at once](../src/python/api/README.md#several-frameworks-at-once)):

```bash
cd src/python/api
./startlocalapi.sh openai_agents   # OpenAI Agents SDK: oai-temporal-agent-session-<session>-chat-<random> on OAI-Supervisor
./startlocalapi.sh pyai            # Pydantic AI: pyai-temporal-agent-session-<session>-chat-<random> on PYAI-Supervisor
./startlocalapi.sh strands_agents  # Strands Agents: strands-temporal-agent-session-<session>-chat-<random> on Strands-Supervisor
./startlocalapi.sh google_adk      # Google ADK: adk-temporal-agent-session-<session>-chat-<random> on ADK-Supervisor
./startlocalapi.sh pure            # Pure Python (LiteLLM): pure-temporal-agent-session-<session>-chat-<random> on Pure-Supervisor
./startlocalapi.sh langgraph_agents  # LangGraph: langgraph-temporal-agent-session-<session>-chat-<random> on LangGraph-Supervisor
./startlocalapi.sh vercel_ai       # Vercel AI SDK (TypeScript): vai-temporal-agent-session-<session>-chat-<random> on VAI-Supervisor
./startlocalapi.sh google_adk_ts   # Google ADK (TypeScript): adk-ts-temporal-agent-session-<session>-chat-<random> on ADK-TS-Supervisor
./startlocalapi.sh strands_agents_ts  # Strands Agents (TypeScript): strands-ts-temporal-agent-session-<session>-chat-<random> on Strands-TS-Supervisor
./startlocalapi.sh openai_agents_ts   # OpenAI Agents SDK (TypeScript): oai-ts-temporal-agent-session-<session>-chat-<random> on OAI-TS-Supervisor
./startlocalapi.sh google_adk_go   # Google ADK (Go): adk-go-temporal-agent-session-<session>-chat-<random> on ADK-Go-Supervisor
./startlocalapi.sh spring_ai       # Spring AI (Java): springai-temporal-agent-session-<session>-chat-<random> on SpringAI-Supervisor
./startlocalapi.sh strands_agents,vercel_ai,google_adk_go   # these three, side by side
./startlocalapi.sh all             # every framework
```

Note that the web application communicates directly with the API and the API is what 
communicates with Temporal running locally or in the cloud.

The web app calls the API at `/api` on its own origin ([`src/config.js`](src/config.js)); the dev server proxies those
calls to the API at http://127.0.0.1:8000 (`"proxy"` in [`package.json`](package.json)). Change the proxy if the API runs
elsewhere.

## Install Dependencies
From the repository root:
```bash
cd frontend
npm install
```

## Running the Web App
```bash
cd frontend
npm start
```

A browser window opens at http://localhost:3000. The sidebar on the left lists the AI frameworks the API serves,
grouped by language (Python, TypeScript, Go); click one to show its chat. The chat's header names the framework, its
language and its task queue. Click **Start chat** to start a conversation. Each chat starts a new chat workflow; the
API picks its ID, named after the AI framework and carrying your browser session, for example
`oai-temporal-agent-session-<session>-chat-<random>`. **End chat** ends it.

Each framework keeps its own chat: start a chat with one, pick another and start one there, and both keep running, so
you can ask several frameworks the same questions and compare. In the sidebar, a green dot marks a framework with a
running chat, and a red count shows replies and status updates that arrived while its chat wasn't shown. A greyed-out
framework, marked "no worker", has no worker running its chats, and its **Start chat** button is off until one starts.
With more than six frameworks, a filter box above the list narrows it down.

While an account opening runs, a status line under the chat header shows its state: amber while it waits, green when
it's complete, red if it was rolled back.

![Several frameworks in the sidebar](../docs/images/webui-frameworks.png)

To start the workers, the API and the web app in one terminal, use
[`scripts/startdemo.sh`](../scripts/README.md#start-the-demo-with-one-command), for example
`scripts/startdemo.sh all`.

The web app calls the API on its own origin, at `/api` (`src/config.js`): the dev server proxies those calls to the API
at http://127.0.0.1:8000 (`"proxy"` in `package.json`). That way the browser keeps the API's session cookie, which
keeps each browser's chats, chaos flags and (with `DEMO_DATA_STORE=redis`) sample data apart from other browsers'. See
[Browser sessions](../src/python/api/README.md#browser-sessions).

Click **Show chaos panel** at the bottom of the sidebar to open the chaos panel (**Hide chaos panel** closes it), which turns failure scenarios on and off
at runtime and lists the failures as they happen. See
[Failure scenarios](../src/python/openai_agents/durable/README.md#failure-scenarios-chaos-panel).

When you open a new investment account, it waits for compliance review after KYC. While the status line says
**Waiting Compliance Review**, click **Approve compliance review** in it, or send the approval from a terminal to
the Open Account child workflow (see
[How to find the Child Workflow ID](../src/python/openai_agents/durable/README.md#approve-compliance)).

### Send the Compliance Reviewed Signal (Local)
```bash
cd src/python/openai_agents/durable
./localsendcomplianceapproval.sh <Child Workflow ID>
```

or
### Send the Compliance Reviewed Signal (Cloud)
```bash
cd src/python/openai_agents/durable
./cloudsendcomplianceapproval.sh <Child Workflow ID>
```

## Tests
```bash
cd frontend
npm test
```

`npm test` starts Jest in watch mode; press `q` to quit (or run `CI=true npm test` to run once).

## Example

Here's the web application with six frameworks, a chat running in four of them, and the chaos panel open. The sidebar
lists the frameworks the API serves (from its `GET /api/config`), and **Show chaos panel** / **Hide chaos panel** at its bottom
opens or hides the chaos panel, which turns failures on and off while you chat. Next to it, the sidebar shows how many
flags are on:

![](../docs/images/webui.png)

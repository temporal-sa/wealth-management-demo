import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import { API_BASE_URL } from './config';
import ChaosPanel from './ChaosPanel';

// Used if the API doesn't report its port's prefix (an API without GET /config).
const DEFAULT_WORKFLOW_ID_PREFIX = 'oai-temporal-agent-';

// A typed reply to a pending approval counts as approval when it starts affirmatively;
// anything else is a denial.
const AFFIRMATIVE = /^\s*(y|yes|yeah|yep|sure|ok|okay|approve|confirm|proceed|do it)\b/i;

// What the API says about the port it serves: the chat workflow ID prefix (e.g.
// pyai-temporal-agent-), so each workflow ID names the SDK that runs it, and whether its
// chat workflow pauses for the customer's approval (the Strands Agents port does).
async function fetchConfig() {
  try {
    const response = await fetch(`${API_BASE_URL}/config`);
    if (response.ok) {
      const config = await response.json();
      return {
        workflowIdPrefix: config.workflow_id_prefix || DEFAULT_WORKFLOW_ID_PREFIX,
        approvals: Boolean(config.approvals),
      };
    }
  } catch (error) {
    console.log(`Couldn't read the API's config, using the defaults: ${error}`);
  }
  return { workflowIdPrefix: DEFAULT_WORKFLOW_ID_PREFIX, approvals: false };
}

const SHOW_CHAOS_KEY = 'showChaosPanel';

function loadShowChaos() {
  try {
    return localStorage.getItem(SHOW_CHAOS_KEY) === 'true';
  } catch (e) {
    return false;
  }
}

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [isChatActive, setIsChatActive] = useState(false);
  const [statusContent, setStatusContent] = useState('');
  const chatWindowRef = useRef(null);
  const eventCountRef = useRef(0);
  // Polling calls the latest fetchChatHistory through this ref, so the interval
  // isn't restarted on every render and never calls a stale copy.
  const fetchChatHistoryRef = useRef(null);
  let [isPolling, setIsPolling] = useState(false);
  const [isWaitingForAIResponse, setIsWaitingForAIResponse] = useState(false);
  const defaultHeaderText = 'Chat session started.';
  const [workflow_id, setWorkflowId] = useState('');
  const [showChaos, setShowChaos] = useState(loadShowChaos);
  // Approvals (only for ports whose chat workflow pauses for them, per GET /config)
  const approvalsRef = useRef(false);
  const [pendingApproval, setPendingApproval] = useState(null);
  // The approval question currently shown in the chat, so it is added only once.
  const approvalShownRef = useRef(null);
  // An approval already answered, until the workflow clears it.
  const answeredApprovalRef = useRef(null);
  // User messages shown as they were sent, until the chat history records their turn.
  const pendingEchoesRef = useRef([]);
  const fetchPendingApprovalRef = useRef(null);

  const handleToggleChaos = () => {
    const next = !showChaos;
    setShowChaos(next);
    try {
      localStorage.setItem(SHOW_CHAOS_KEY, String(next));
    } catch (e) {
      // Not remembered across reloads; the panel still toggles.
    }
  };

  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [messages]);

    // This useEffect hook manages the polling logic.
  useEffect(() => {
    let intervalId;

    if (isPolling) {
      // Define the polling function
      const pollApi = async () => {
        try {
           await fetchChatHistoryRef.current(defaultHeaderText)
           if (approvalsRef.current) {
             await fetchPendingApprovalRef.current();
           }
        } catch (error) {
          console.error('Error polling API:', error);
        }
      };

      // Call the function immediately on start
      pollApi();

      // Set up the interval with dynamic frequency:
      // 2 seconds when waiting for AI response, 5 seconds when waiting for user input
      const pollingInterval = isWaitingForAIResponse ? 2000 : 5000;
      console.log(`Setting polling interval to ${pollingInterval}ms (waiting for AI: ${isWaitingForAIResponse})`);
      intervalId = setInterval(pollApi, pollingInterval);
    }

    // The cleanup function is crucial for preventing memory leaks
    // It runs when the component unmounts or when the dependencies change
    return () => {
      clearInterval(intervalId);
      console.log('Polling stopped.');
    };
  }, [isPolling, isWaitingForAIResponse]); // The effect re-runs whenever the isPolling or isWaitingForAIResponse state changes

  const handleStartChat = async () => {
    try {
      let response;
      const newSessionId = Math.random().toString(36).substring(2, 15);
      const config = await fetchConfig();
      const newWorkflowId = config.workflowIdPrefix + newSessionId;
      console.log(`Getting ready to start workflow with id ${newWorkflowId}`);
      response = await fetch(`${API_BASE_URL}/start-workflow?workflow_id=${newWorkflowId}`, { method: 'POST' });
      if (response.ok) {
        const result = await response.json();

        // check to see if it has truly been started
        if (result.message === 'Workflow started.') {
          console.log('Workflow has been started.');
          setWorkflowId(newWorkflowId);
          approvalsRef.current = config.approvals;
          setPendingApproval(null);
          approvalShownRef.current = null;
          answeredApprovalRef.current = null;
          pendingEchoesRef.current = [];
          setMessages([{text: defaultHeaderText, type: 'bot'}]);
          setIsChatActive(true);
          eventCountRef.current = 0;
          setSessionId(newSessionId);
          setIsPolling(true); // Start polling immediately when chat becomes active
          setIsWaitingForAIResponse(false); // Start with slower polling until user sends a message
        } else {
          setMessages([{text: `Workflow didn't start. Error ${result.message}`, type: 'bot'}]);
          setIsPolling(false);
        }
      } else {
        setMessages( [{text: `Bad/invalid response from API: ${response.status}`, type: 'bot'}]);
        setIsPolling(false);
      }
    } catch (error) {
      console.error('Error starting chat session:', error);
      setMessages([{ text: 'Failed to start chat session.', type: 'bot' }]);
      setIsPolling(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !sessionId) {
      console.log('either nothing to send or session Id is empty');
      return;
    }

    const userMessage = { text: input, type: 'user' };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsWaitingForAIResponse(true); // Switch to faster polling (2s) while waiting for AI response

    // While the chat waits for an approval, this message is the answer: send it to the
    // approve signal instead. It isn't a turn of its own in the chat history.
    if (pendingApproval) {
      const response = AFFIRMATIVE.test(input) ? 'approve' : 'deny';
      answeredApprovalRef.current = pendingApproval;
      setPendingApproval(null);
      try {
        await fetch(`${API_BASE_URL}/approve?workflow_id=${workflow_id}&response=${response}`, { method: 'POST' });
      } catch (error) {
        console.error('Error sending approval:', error);
      }
      return;
    }

    pendingEchoesRef.current.push(input);
    try {
      const encodedInput = encodeURIComponent(input);
      const response = await fetch(`${API_BASE_URL}/send-prompt?workflow_id=${workflow_id}&prompt=${encodedInput}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      // const data =
      await response.json();
      // if (data.response && data.response.length > 0) {
      //   console.log("data coming back is ", data.response[0].text_response)
      //   // nothing to do
      //   // const botMessage = { text: data.response[0].text_response, type: 'bot' };
      //   // setMessages(prev => [...prev, botMessage]);
      // }
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = { text: 'Failed to get response from bot.', type: 'bot' };
      setMessages(prev => [...prev, errorMessage]);
    }
  };

  const handleEndChat = async () => {
    console.log("Session id is ", sessionId);
    if (!sessionId) {
      return;
    }
    try {
      await fetch(`${API_BASE_URL}/end-chat?workflow_id=${workflow_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      setIsPolling(false);
      setIsWaitingForAIResponse(false); // Reset polling state
      setMessages(prev => [...prev, { text: 'Chat session ended.', type: 'bot' }]);
      setSessionId(null);
      setIsChatActive(false);
    } catch (error) {
        console.error('Error ending chat session:', error);
        setIsPolling(false);
    }
  };

  const handleToggleChatState = () => {
    if (isChatActive) {
      handleEndChat();
    } else {
      handleStartChat();
      setStatusContent('');
    }
  };

  const fetchChatHistory = async (headerText) => {
    const currentEventCount = eventCountRef.current;
    console.log("fetching chat history, event count is ", currentEventCount);

    let data = null;
    // if (!sessionId) return;
    try {
      const response = await fetch(`${API_BASE_URL}/get-chat-history?workflow_id=${workflow_id}&from_index=${currentEventCount}`);
      data = await response.json();
    } catch (error) {
      console.error('Error fetching chat history:', error);
      return;
    }

    if (data === null || data.length === 0) {
      return;
    }

    const newEventCount = currentEventCount + data.length;
    console.log(`Processing ${data.length} new events, eventCount: ${currentEventCount} -> ${newEventCount}`);
    
    eventCountRef.current = newEventCount;

    const newMessages = [];
    let receivedBotResponse = false;
    data.forEach(item => {
      switch (item.type) {
        case 'chat_interaction': {
          // The user's message is already shown if it was sent from this page: add only the
          // reply. Matching by text (not by position) copes with an approval question and
          // answer shown between the message and its reply.
          const echoIndex = pendingEchoesRef.current.indexOf(item.content.user_prompt);
          if (echoIndex !== -1) {
            pendingEchoesRef.current.splice(echoIndex, 1);
          } else {
            newMessages.push({ text: item.content.user_prompt, type: 'user' });
          }
          newMessages.push({ text: item.content.text_response, type: 'bot' });
          receivedBotResponse = true;
          break;
        }
        case 'status_update':
          setStatusContent(item.content.status);
          break;
        default:
          // No Default
      }
    });
    
    if (receivedBotResponse) {
      setIsWaitingForAIResponse(false);
    }
    if (newMessages.length > 0) {
      setMessages(prev => [...prev, ...newMessages]);
    }
  };
  fetchChatHistoryRef.current = fetchChatHistory;

  // Shows the approval question the chat is waiting on (once), so the customer can answer
  // it by typing a reply (see handleSend).
  const fetchPendingApproval = async () => {
    let question = null;
    try {
      const response = await fetch(`${API_BASE_URL}/pending-approval?workflow_id=${workflow_id}`);
      question = (await response.json()).pending || null;
    } catch (error) {
      return; // try again on the next poll
    }
    if (!question) {
      answeredApprovalRef.current = null;
      approvalShownRef.current = null;
      setPendingApproval(null);
      return;
    }
    if (question === answeredApprovalRef.current) {
      return; // answered; waiting for the workflow to clear it
    }
    setPendingApproval(question);
    if (approvalShownRef.current !== question) {
      approvalShownRef.current = question;
      setMessages(prev => [...prev, { text: question, type: 'bot' }]);
      setIsWaitingForAIResponse(false);
    }
  };
  fetchPendingApprovalRef.current = fetchPendingApproval;

  return (
    <div className="layout">
      <div className="App">
        <div className="header">
          Wealth Management Chatbot
          <button className="chaos-toggle" onClick={handleToggleChaos}>
            {showChaos ? 'Hide chaos' : 'Chaos'}
          </button>
        </div>
        {statusContent && (
          <div className="status-area">
            {statusContent}
          </div>
        )}
        <div className="chat-window" ref={chatWindowRef}>
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.type}`}>
              {msg.text.split('\n').map((line, i) => (
                    <span key={i}>
                      {line}
                      <br />
                    </span>
              ))}
            </div>
          ))}
        </div>
        <div className="input-area">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
            disabled={!isChatActive}
          />
          <button onClick={handleSend} disabled={!isChatActive}>Send</button>
        </div>
        <button
          onClick={handleToggleChatState}
          className={`end-chat-button ${!isChatActive ? 'start-chat-button' : ''}`}
        >
          {isChatActive ? 'End Chat' : 'Start Chat'}
        </button>
      </div>
      {showChaos && <ChaosPanel />}
    </div>
  );
}

export default App;


import React, { useState, useEffect, useRef } from 'react';
import Markdown from './Markdown';
import { API_BASE_URL } from './config';

const defaultHeaderText = 'Chat session started.';

// One framework's chat: its own chat workflow, messages, status bar and polling. The web UI keeps one
// of these per tab, all mounted, so a chat keeps running (and its replies keep arriving) while another
// tab is shown.
//
// framework: the framework's entry in GET /api/config, or null when the API's config couldn't be read
//   (the chat then starts without naming a framework, which works when the API serves just one).
// visible: whether this tab is the one shown.
// onChange: called with {active} when a chat starts or ends, and {unseen: true} when a reply
//   arrives while the tab is hidden.
function ChatPane({ framework, visible, onChange = () => {} }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isChatActive, setIsChatActive] = useState(false);
  const [statusContent, setStatusContent] = useState('');
  // While an approval is on its way, until the opening's status changes
  const [isApprovingCompliance, setIsApprovingCompliance] = useState(false);
  const chatWindowRef = useRef(null);
  const eventCountRef = useRef(0);
  // Polling calls the latest fetchChatHistory through this ref, so the interval
  // isn't restarted on every render and never calls a stale copy.
  const fetchChatHistoryRef = useRef(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [isPolling, setIsPolling] = useState(false);
  const [isWaitingForAIResponse, setIsWaitingForAIResponse] = useState(false);
  const [workflowId, setWorkflowId] = useState('');

  const unavailable = framework && framework.available === false;

  useEffect(() => {
    onChangeRef.current({ active: isChatActive });
  }, [isChatActive]);

  // Scroll to the newest message, and again when the tab is shown (a hidden chat window has no height)
  useEffect(() => {
    if (visible && chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [messages, visible]);

  useEffect(() => {
    let intervalId;

    if (isPolling) {
      const pollApi = async () => {
        try {
          await fetchChatHistoryRef.current();
        } catch (error) {
          console.error('Error polling API:', error);
        }
      };

      pollApi();

      // 2 seconds when waiting for an AI response, 5 seconds when waiting for the customer
      const pollingInterval = isWaitingForAIResponse ? 2000 : 5000;
      intervalId = setInterval(pollApi, pollingInterval);
    }

    return () => clearInterval(intervalId);
  }, [isPolling, isWaitingForAIResponse]);

  const handleStartChat = async () => {
    try {
      // The API picks the chat's workflow ID, in this browser's session, and returns it
      const query = framework ? `?framework=${encodeURIComponent(framework.framework)}` : '';
      const response = await fetch(`${API_BASE_URL}/start-workflow${query}`, { method: 'POST' });
      if (response.ok) {
        const result = await response.json();

        if (result.message === 'Workflow started.' && result.workflow_id) {
          console.log(`Workflow ${result.workflow_id} has been started.`);
          setWorkflowId(result.workflow_id);
          setMessages([{ text: defaultHeaderText, type: 'bot' }]);
          setIsChatActive(true);
          eventCountRef.current = 0;
          setIsPolling(true);
          setIsWaitingForAIResponse(false);
        } else {
          setMessages([{ text: `Workflow didn't start. Error ${result.message}`, type: 'bot' }]);
          setIsPolling(false);
        }
      } else {
        setMessages([{ text: `Bad/invalid response from API: ${response.status}`, type: 'bot' }]);
        setIsPolling(false);
      }
    } catch (error) {
      console.error('Error starting chat session:', error);
      setMessages([{ text: 'Failed to start chat session.', type: 'bot' }]);
      setIsPolling(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !workflowId) {
      return;
    }

    setMessages((prev) => [...prev, { text: input, type: 'user' }]);
    setInput('');
    setIsWaitingForAIResponse(true);

    try {
      const response = await fetch(
        `${API_BASE_URL}/send-prompt?workflow_id=${encodeURIComponent(workflowId)}&prompt=${encodeURIComponent(input)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      await response.json();
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages((prev) => [...prev, { text: 'Failed to get response from bot.', type: 'bot' }]);
    }
  };

  // The status text each chat shows while an account opening waits for compliance review
  const isWaitingComplianceReview = isChatActive && statusContent.endsWith('Waiting Compliance Review');

  useEffect(() => {
    setIsApprovingCompliance(false);
  }, [statusContent]);

  // Does what localsendcomplianceapproval.sh does: the API signals the chat's account openings
  // that wait for compliance review
  const handleApproveCompliance = async () => {
    setIsApprovingCompliance(true);
    try {
      const response = await fetch(`${API_BASE_URL}/approve-compliance?workflow_id=${encodeURIComponent(workflowId)}`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!response.ok || !result.approved || result.approved.length === 0) {
        console.error('No account opening was approved:', result);
        setIsApprovingCompliance(false);
      }
    } catch (error) {
      console.error('Error approving compliance:', error);
      setIsApprovingCompliance(false);
    }
  };

  const handleEndChat = async () => {
    if (!workflowId) {
      return;
    }
    try {
      await fetch(`${API_BASE_URL}/end-chat?workflow_id=${encodeURIComponent(workflowId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      setIsPolling(false);
      setIsWaitingForAIResponse(false);
      setMessages((prev) => [...prev, { text: 'Chat session ended.', type: 'bot' }]);
      setWorkflowId('');
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

  const fetchChatHistory = async () => {
    const currentEventCount = eventCountRef.current;

    let data = null;
    try {
      const response = await fetch(
        `${API_BASE_URL}/get-chat-history?workflow_id=${encodeURIComponent(workflowId)}&from_index=${currentEventCount}`,
      );
      data = await response.json();
    } catch (error) {
      console.error('Error fetching chat history:', error);
      return;
    }

    if (data === null || data.length === 0 || !Array.isArray(data)) {
      return;
    }

    eventCountRef.current = currentEventCount + data.length;

    const newMessages = [];
    let receivedBotResponse = false;
    data.forEach((item) => {
      switch (item.type) {
        case 'chat_interaction':
          newMessages.push(
            { text: item.content.user_prompt, type: 'user' },
            { text: item.content.text_response, type: 'bot' },
          );
          receivedBotResponse = true;
          break;
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
    if (!visibleRef.current && data.length > 0) {
      onChangeRef.current({ unseen: true });
    }
    if (newMessages.length > 0) {
      setMessages((prev) => {
        // The customer's message is already shown: skip it if it is the last one
        if (prev.length > 0
            && newMessages[0].type === prev[prev.length - 1].type
            && newMessages[0].text === prev[prev.length - 1].text) {
          return [...prev, ...newMessages.slice(1)];
        }
        return [...prev, ...newMessages];
      });
    }
  };
  fetchChatHistoryRef.current = fetchChatHistory;

  return (
    <div className="chat-pane" hidden={!visible}>
      {statusContent && (
        <div className="status-area">
          {statusContent}
          {isWaitingComplianceReview && (
            <button
              className="approve-compliance-button"
              onClick={handleApproveCompliance}
              disabled={isApprovingCompliance}
            >
              {isApprovingCompliance ? 'Approving…' : 'Approve compliance review'}
            </button>
          )}
        </div>
      )}
      <div className="chat-window" ref={chatWindowRef}>
        {unavailable && !isChatActive && (
          <div className="no-worker">
            No worker is running {framework.label} chats (task queue {framework.task_queue}).
            Start its worker to chat with it.
          </div>
        )}
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.type}`}>
            {msg.type === 'bot' ? (
              <Markdown text={msg.text} />
            ) : (
              msg.text.split('\n').map((line, i) => (
                <span key={i}>
                  {line}
                  <br />
                </span>
              ))
            )}
          </div>
        ))}
      </div>
      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Type a message..."
          disabled={!isChatActive}
        />
        <button onClick={handleSend} disabled={!isChatActive}>Send</button>
      </div>
      <button
        onClick={handleToggleChatState}
        className={`end-chat-button ${!isChatActive ? 'start-chat-button' : ''}`}
        disabled={!isChatActive && unavailable}
      >
        {isChatActive ? 'End Chat' : 'Start Chat'}
      </button>
    </div>
  );
}

export default ChatPane;

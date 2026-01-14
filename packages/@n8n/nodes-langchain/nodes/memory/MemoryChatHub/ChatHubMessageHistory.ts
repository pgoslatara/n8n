import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage, ToolCall } from '@langchain/core/messages';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { IChatHubMemoryService, ChatHubMemoryEntry } from 'n8n-workflow';

/**
 * Structure for storing AI messages that include tool calls.
 * When an AI message has tool_calls, we serialize it as JSON including both
 * the content and the tool_calls array, so they can be properly reconstructed.
 */
interface StoredAIMessageWithToolCalls {
	content: string;
	toolCalls: ToolCall[];
}

/**
 * LangChain message history implementation that uses n8n's Chat Hub memory.
 * Memory is stored separately from chat UI messages, allowing:
 * - Multiple memory nodes in the same workflow to have isolated memory
 * - Proper branching on edit/retry via parentMessageId linking
 */
export class ChatHubMessageHistory extends BaseChatMessageHistory {
	lc_namespace = ['langchain', 'stores', 'message', 'n8n_chat_hub'];

	private memoryService: IChatHubMemoryService;

	constructor(options: { memoryService: IChatHubMemoryService }) {
		super();
		this.memoryService = options.memoryService;
	}

	async getMessages(): Promise<BaseMessage[]> {
		const entries = await this.memoryService.getMemory();
		return entries.map((entry) => this.convertToLangChainMessage(entry));
	}

	private convertToLangChainMessage(entry: ChatHubMemoryEntry): BaseMessage {
		switch (entry.role) {
			case 'human':
				return new HumanMessage({ content: entry.content, name: entry.name ?? undefined });

			case 'ai': {
				const aiData = this.parseAIMessageContent(entry.content);
				return new AIMessage({
					content: aiData.content,
					name: entry.name ?? undefined,
					tool_calls: aiData.toolCalls,
				});
			}

			case 'system':
				return new SystemMessage({ content: entry.content });

			case 'tool': {
				// Parse tool message content
				const toolData = this.parseToolMessageContent(entry.content);
				return new ToolMessage({
					content: JSON.stringify(toolData.toolOutput),
					tool_call_id: toolData.toolCallId,
					name: toolData.toolName,
				});
			}

			default:
				// Unknown role treated as system
				return new SystemMessage({ content: entry.content });
		}
	}

	/**
	 * Parse AI message content stored as JSON: { content: "...", toolCalls: [...] }
	 */
	private parseAIMessageContent(content: string): { content: string; toolCalls: ToolCall[] } {
		try {
			const parsed = JSON.parse(content) as StoredAIMessageWithToolCalls;
			return {
				content:
					typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content),
				toolCalls: parsed.toolCalls ?? [],
			};
		} catch {
			// Fallback for malformed data
			return { content, toolCalls: [] };
		}
	}

	private parseToolMessageContent(content: string): {
		toolCallId: string;
		toolName: string;
		toolInput: unknown;
		toolOutput: unknown;
	} {
		try {
			return JSON.parse(content);
		} catch {
			// Fallback for malformed tool messages
			return {
				toolCallId: 'unknown',
				toolName: 'unknown',
				toolInput: {},
				toolOutput: content,
			};
		}
	}

	async addMessage(message: BaseMessage): Promise<void> {
		const messageType = message._getType();
		const content =
			typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

		if (messageType === 'human') {
			await this.memoryService.addHumanMessage(content);
		} else if (messageType === 'ai') {
			const aiMsg = message as AIMessage;
			// Store AI messages as JSON with content and tool_calls
			// This ensures ToolMessages can be properly matched when reconstructing history
			const storedContent: StoredAIMessageWithToolCalls = {
				content,
				toolCalls: aiMsg.tool_calls ?? [],
			};
			await this.memoryService.addAIMessage(JSON.stringify(storedContent));
		} else if (messageType === 'tool') {
			const toolMsg = message as ToolMessage;
			await this.memoryService.addToolMessage(
				toolMsg.tool_call_id,
				toolMsg.name ?? 'unknown',
				{}, // Input not available from ToolMessage
				typeof toolMsg.content === 'string' ? toolMsg.content : toolMsg.content,
			);
		}
		// System messages are typically not saved in conversation history
	}

	async addMessages(messages: BaseMessage[]): Promise<void> {
		for (const message of messages) {
			await this.addMessage(message);
		}
	}

	async addUserMessage(message: string): Promise<void> {
		await this.addMessage(new HumanMessage(message));
	}

	async addAIMessage(message: string): Promise<void> {
		await this.addMessage(new AIMessage(message));
	}

	async clear(): Promise<void> {
		await this.memoryService.clearMemory();
	}
}

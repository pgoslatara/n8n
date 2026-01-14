import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import {
	ChatHubProxyProvider,
	IChatHubMemoryService,
	ChatHubMemoryEntry,
	INode,
	Workflow,
} from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import { buildMessageHistory, extractHumanMessageIds } from './chat-hub-history.utils';
import { ChatHubMemoryRepository } from './chat-hub-memory.repository';
import { ChatHubMessageRepository } from './chat-message.repository';
import { ChatHubSessionRepository } from './chat-session.repository';

const ALLOWED_NODES = ['@n8n/n8n-nodes-langchain.memoryChatHub'] as const;
const NAME_FALLBACK = 'Workflow Chat';

type AllowedNode = (typeof ALLOWED_NODES)[number];

export function isAllowedNode(s: string): s is AllowedNode {
	return ALLOWED_NODES.includes(s as AllowedNode);
}

@Service()
export class ChatHubProxyService implements ChatHubProxyProvider {
	constructor(
		private readonly memoryRepository: ChatHubMemoryRepository,
		private readonly messageRepository: ChatHubMessageRepository,
		private readonly sessionRepository: ChatHubSessionRepository,
		private readonly logger: Logger,
	) {
		this.logger = this.logger.scoped('chat-hub');
	}

	private validateRequest(node: INode) {
		if (!isAllowedNode(node.type)) {
			throw new Error('This proxy is only available for Chat Hub Memory nodes');
		}
	}

	async getChatHubProxy(
		workflow: Workflow,
		node: INode,
		sessionId: string,
		memoryNodeId: string,
		parentMessageId: string | null,
		excludeCurrentFromMemory: boolean,
		ownerId?: string,
	): Promise<IChatHubMemoryService> {
		this.validateRequest(node);

		if (!ownerId) {
			throw new Error(
				'Owner ID is required for Chat Hub Memory. For manual executions, ensure the user context is available.',
			);
		}

		// Extract workflow info for session creation
		const workflowId = workflow.id;
		const agentName = this.extractAgentName(workflow);

		return this.makeChatHubOperations(
			sessionId,
			memoryNodeId,
			parentMessageId,
			excludeCurrentFromMemory,
			ownerId,
			workflowId,
			agentName,
		);
	}

	/**
	 * Extract agent name from the chat trigger node's agentName parameter,
	 * falling back to workflow name if not set.
	 */
	private extractAgentName(workflow: Workflow): string {
		// Look for chat trigger node
		const chatTriggerNode = Object.values(workflow.nodes).find(
			(n) => n.type === '@n8n/n8n-nodes-langchain.chatTrigger',
		);

		if (
			typeof chatTriggerNode?.parameters?.agentName === 'string' &&
			chatTriggerNode.parameters.agentName.trim() !== ''
		) {
			return String(chatTriggerNode.parameters.agentName);
		}

		// Fall back to workflow name or default
		if (workflow.name && workflow.name.trim() !== '') {
			return workflow.name;
		}

		return NAME_FALLBACK;
	}

	private makeChatHubOperations(
		sessionId: string,
		memoryNodeId: string,
		initialParentMessageId: string | null,
		excludeCurrentFromMemory: boolean,
		ownerId: string,
		workflowId: string | undefined,
		agentName: string,
	): IChatHubMemoryService {
		const memoryRepository = this.memoryRepository;
		const messageRepository = this.messageRepository;
		const sessionRepository = this.sessionRepository;
		const logger = this.logger;

		// Track the resolved parentMessageId - may be looked up if not provided
		let resolvedParentMessageId: string | null = initialParentMessageId;
		let parentMessageIdResolved = initialParentMessageId !== null;

		/**
		 * Resolve the parentMessageId if not provided.
		 * For manual executions, look up the latest human message in the session.
		 */
		async function resolveParentMessageId(): Promise<string | null> {
			if (parentMessageIdResolved) {
				return resolvedParentMessageId;
			}

			// Look up the latest human message in the session
			const chatMessages = await messageRepository.getManyBySessionId(sessionId);
			const messageChain = buildMessageHistory(chatMessages);
			const humanMessageIds = extractHumanMessageIds(messageChain);

			if (humanMessageIds.length > 0) {
				// Use the most recent human message as the parent
				resolvedParentMessageId = humanMessageIds[humanMessageIds.length - 1];
				logger.debug('Resolved parentMessageId from latest human message', {
					sessionId,
					memoryNodeId,
					resolvedParentMessageId,
				});
			} else {
				// No human messages yet - this is manual execution / execution outside Chat Hub
				resolvedParentMessageId = null;
				logger.debug('No human messages in session - starting fresh', {
					sessionId,
					memoryNodeId,
				});
			}

			parentMessageIdResolved = true;
			return resolvedParentMessageId;
		}

		return {
			getOwnerId() {
				return ownerId;
			},

			async getMemory(): Promise<ChatHubMemoryEntry[]> {
				const parentMessageId = await resolveParentMessageId();

				// If we have a parentMessageId, load memory with branching support
				if (parentMessageId) {
					// Get all chat messages for the session
					const chatMessages = await messageRepository.getManyBySessionId(sessionId);

					// Build the message chain up to parentMessageId
					const messageChain = buildMessageHistory(chatMessages, parentMessageId);

					// Extract human message IDs from the chain
					// These are the parent message IDs we should filter memory by
					const humanMessageIds = extractHumanMessageIds(messageChain);

					// For regeneration, exclude the current parentMessageId from the lookup
					// since we don't want memory from the execution we're regenerating
					if (excludeCurrentFromMemory) {
						const index = humanMessageIds.indexOf(parentMessageId);
						if (index !== -1) {
							humanMessageIds.splice(index, 1);
						}
						logger.debug('Excluding current parentMessageId from memory lookup (regeneration)', {
							sessionId,
							memoryNodeId,
							parentMessageId,
							humanMessageIds,
						});
					} else {
						// Include the current parentMessageId if it's not already in the chain
						// (it should be, but just in case)
						if (!humanMessageIds.includes(parentMessageId)) {
							humanMessageIds.push(parentMessageId);
						}
					}

					// If no human message IDs remain after exclusion, return empty memory
					if (humanMessageIds.length === 0) {
						return [];
					}

					// Load memory entries for this node filtered by the human message chain
					const memoryEntries = await memoryRepository.getMemoryByParentMessageIds(
						sessionId,
						memoryNodeId,
						humanMessageIds,
					);

					return memoryEntries.map((entry) => ({
						id: entry.id,
						role: entry.role,
						content: entry.content,
						name: entry.name,
						createdAt: entry.createdAt,
					}));
				}

				// No parentMessageId (manual execution / execution outside Chat Hub) - load all memory for this node
				const memoryEntries = await memoryRepository.getAllMemoryForNode(sessionId, memoryNodeId);

				return memoryEntries.map((entry) => ({
					id: entry.id,
					role: entry.role,
					content: entry.content,
					name: entry.name,
					createdAt: entry.createdAt,
				}));
			},

			async addHumanMessage(content: string): Promise<void> {
				const parentMessageId = await resolveParentMessageId();
				const id = uuid();
				await memoryRepository.createMemoryEntry({
					id,
					sessionId,
					memoryNodeId,
					parentMessageId,
					role: 'human',
					content,
					name: 'User',
				});
				logger.debug('Added human message to memory', { sessionId, memoryNodeId, memoryId: id });
			},

			async addAIMessage(content: string): Promise<void> {
				const parentMessageId = await resolveParentMessageId();
				const id = uuid();
				await memoryRepository.createMemoryEntry({
					id,
					sessionId,
					memoryNodeId,
					parentMessageId,
					role: 'ai',
					content,
					name: 'AI',
				});
				logger.debug('Added AI message to memory', { sessionId, memoryNodeId, memoryId: id });
			},

			async addToolMessage(
				toolCallId: string,
				toolName: string,
				toolInput: unknown,
				toolOutput: unknown,
			): Promise<void> {
				const parentMessageId = await resolveParentMessageId();
				const id = uuid();
				const content = JSON.stringify({
					toolCallId,
					toolName,
					toolInput,
					toolOutput,
				});

				await memoryRepository.createMemoryEntry({
					id,
					sessionId,
					memoryNodeId,
					parentMessageId,
					role: 'tool',
					content,
					name: toolName,
				});
				logger.debug('Added tool message to memory', {
					sessionId,
					memoryNodeId,
					memoryId: id,
					toolName,
				});
			},

			async clearMemory(): Promise<void> {
				await memoryRepository.deleteBySessionAndNode(sessionId, memoryNodeId);
				logger.debug('Cleared memory for node', { sessionId, memoryNodeId });
			},

			async ensureSession(title?: string): Promise<void> {
				const exists = await sessionRepository.existsById(sessionId, ownerId);
				if (!exists) {
					// Use provided title, or fall back to agentName from workflow
					const sessionTitle = title || agentName;
					await sessionRepository.createChatSession({
						id: sessionId,
						ownerId,
						title: sessionTitle,
						lastMessageAt: new Date(),
						tools: [],
						provider: 'n8n',
						credentialId: null,
						model: null,
						workflowId: workflowId ?? null,
						agentId: null,
						agentName,
					});
					logger.debug('Created new chat hub session', {
						sessionId,
						ownerId,
						title: sessionTitle,
						workflowId,
						agentName,
					});
				}
			},
		};
	}
}

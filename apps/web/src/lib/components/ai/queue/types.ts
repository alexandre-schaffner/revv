export interface QueueMessagePart {
	type: string;
	text?: string;
	url?: string;
	filename?: string;
	mediaType?: string;
}

export interface QueueMessage {
	id: string;
	parts: QueueMessagePart[];
}

export interface QueueTodo {
	id: string;
	title: string;
	description?: string;
	status?: "pending" | "completed";
}

// `@ezil`: a chat participant that answers with the selected EZiL model and offers it NO tools. Agent mode
// always offers tools (Copilot adds some the tool picker cannot turn off), so this is the supported way to ask a
// plain question: the request carries no `tools` and no `tool_choice` (gateway-messages.ts), never reads or edits
// files, and is eligible for the Gateway's exact response cache when the model is non-streamed.
import * as vscode from 'vscode';

export const PARTICIPANT_ID = 'ezil-models.ezil';
export const PARTICIPANT_VENDOR = 'ezil';

const REFERENCES_NOTE = '_@ezil answers from your message only: attached files and #-references are not sent._\n\n';
const OTHER_MODEL_NOTE = '@ezil answers with EZiL models only. Pick an EZiL model in the model picker, then ask again.';

/** Earlier @ezil turns of this chat as plain text, then the new prompt. Turns of other participants are left out. */
export function noToolsMessages(context: Pick<vscode.ChatContext, 'history'>, prompt: string): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];
    for (const turn of context.history) {
        if (turn.participant !== PARTICIPANT_ID) continue;
        if (turn instanceof vscode.ChatRequestTurn) {
            if (turn.prompt) messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
            const text = turn.response.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '').join('');
            if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
    }
    messages.push(vscode.LanguageModelChatMessage.User(prompt));
    return messages;
}

export async function handleNoToolsRequest(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken): Promise<vscode.ChatResult> {
    if (request.model.vendor !== PARTICIPANT_VENDOR) {
        stream.markdown(OTHER_MODEL_NOTE);
        return {};
    }
    if (request.references.length) stream.markdown(REFERENCES_NOTE);
    try {
        // No options: no tools and no tool mode, so the provider sends neither `tools` nor `tool_choice`.
        const response = await request.model.sendRequest(noToolsMessages(context, request.prompt), {}, token);
        for await (const chunk of response.text) stream.markdown(chunk);
        return {};
    } catch (error) {
        return { errorDetails: { message: error instanceof Error ? error.message : String(error) } };
    }
}

export function registerNoToolsParticipant(): vscode.ChatParticipant {
    return vscode.chat.createChatParticipant(PARTICIPANT_ID, handleNoToolsRequest);
}

import React, { useRef, useState } from "react";
import {
    ActivityIndicator,
    Modal,
    Pressable,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

const API_BASE_URL = "http://127.0.0.1:8000";
const AUTH_TOKEN = "demo-user-1-token";

type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
};

type ApprovalPayload = {
    type: string;
    from_account_id: string;
    to_account_id: string;
    amount: number;
    currency: string;
    prompt: string;
};

export default function App() {
    const threadIdRef = useRef<string>(`thread_${Date.now()}`);
    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            id: "welcome",
            role: "assistant",
            content:
                "Hi! Ask me for your account balances, recent transactions, or to transfer money between your accounts.",
        },
    ]);
    const [input, setInput] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [pendingApproval, setPendingApproval] = useState<ApprovalPayload | null>(null);

    const consumeSseStream = async (url: string, body: object, assistantMsgId: string) => {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                Authorization: `Bearer ${AUTH_TOKEN}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";

            for (const frame of frames) {
                let eventName = "message";
                let dataLine = "";

                for (const line of frame.split("\n")) {
                    if (line.startsWith("event:")) eventName = line.slice(6).trim();
                    if (line.startsWith("data:")) dataLine += line.slice(5).trim();
                }

                if (!dataLine) continue;
                const parsed = JSON.parse(dataLine);

                if (eventName === "token" && parsed.text) {
                    setMessages((prev) =>
                        prev.map((m) =>
                            m.id === assistantMsgId ? { ...m, content: m.content + parsed.text } : m
                        )
                    );
                } else if (eventName === "approval_required" && parsed.interrupt) {
                    setPendingApproval(parsed.interrupt as ApprovalPayload);
                } else if (eventName === "error" && parsed.message) {
                    setMessages((prev) =>
                        prev.map((m) =>
                            m.id === assistantMsgId
                                ? { ...m, content: `${m.content}\n[Error: ${parsed.message}]` }
                                : m
                        )
                    );
                }
            }
        }
    };

    const handleSend = async () => {
        const trimmed = input.trim();
        if (!trimmed || streaming) return;

        const userMsg: ChatMessage = {
            id: `u_${Date.now()}`,
            role: "user",
            content: trimmed,
        };
        const assistantMsgId = `a_${Date.now() + 1}`;

        setMessages((prev) => [
            ...prev,
            userMsg,
            { id: assistantMsgId, role: "assistant", content: "" },
        ]);
        setInput("");
        setStreaming(true);

        try {
            await consumeSseStream(
                `${API_BASE_URL}/api/v1/agent/chat/stream`,
                { thread_id: threadIdRef.current, message: trimmed },
                assistantMsgId
            );
        } catch (err: any) {
            setMessages((prev) =>
                prev.map((m) =>
                    m.id === assistantMsgId
                        ? { ...m, content: `Connection error: ${err?.message ?? "Unknown"}` }
                        : m
                )
            );
        } finally {
            setStreaming(false);
        }
    };

    const handleApprovalDecision = async (approved: boolean) => {
        if (!pendingApproval || streaming) return;
        setPendingApproval(null);
        setStreaming(true);

        const assistantMsgId = `a_confirm_${Date.now()}`;
        setMessages((prev) => [
            ...prev,
            { id: assistantMsgId, role: "assistant", content: "" },
        ]);

        try {
            await consumeSseStream(
                `${API_BASE_URL}/api/v1/agent/confirm`,
                { thread_id: threadIdRef.current, approved },
                assistantMsgId
            );
        } catch (err: any) {
            setMessages((prev) =>
                prev.map((m) =>
                    m.id === assistantMsgId
                        ? { ...m, content: `Confirmation error: ${err?.message ?? "Unknown"}` }
                        : m
                )
            );
        } finally {
            setStreaming(false);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Bank Assistant (Web)</Text>
                <Text style={styles.headerSub}>Thread: {threadIdRef.current}</Text>
            </View>

            <ScrollView style={styles.chatArea} contentContainerStyle={styles.chatContent}>
                {messages.map((m) => (
                    <View
                        key={m.id}
                        style={[
                            styles.bubble,
                            m.role === "user" ? styles.userBubble : styles.assistantBubble,
                        ]}
                    >
                        <Text style={m.role === "user" ? styles.userText : styles.assistantText}>
                            {m.content || (streaming ? "..." : "")}
                        </Text>
                    </View>
                ))}
            </ScrollView>

            <View style={styles.inputBar}>
                <TextInput
                    style={styles.input}
                    value={input}
                    onChangeText={setInput}
                    onSubmitEditing={handleSend}
                    placeholder="Ask balance or 'Transfer $250 from chk_101 to sav_102'..."
                    editable={!streaming}
                />
                <Pressable style={styles.sendBtn} onPress={handleSend} disabled={streaming}>
                    {streaming ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <Text style={styles.sendText}>Send</Text>
                    )}
                </Pressable>
            </View>

            <Modal visible={Boolean(pendingApproval)} transparent animationType="fade">
                <View style={styles.modalBackdrop}>
                    <View style={styles.modalCard}>
                        <Text style={styles.modalTitle}>Confirm Transfer</Text>
                        <Text style={styles.modalBody}>{pendingApproval?.prompt}</Text>
                        <Text style={styles.modalMeta}>
                            From: {pendingApproval?.from_account_id} → To: {pendingApproval?.to_account_id}
                        </Text>
                        <Text style={styles.modalMeta}>
                            Amount: ${pendingApproval?.amount?.toFixed(2)} {pendingApproval?.currency}
                        </Text>
                        <View style={styles.modalActions}>
                            <Pressable
                                style={[styles.actionBtn, styles.rejectBtn]}
                                onPress={() => handleApprovalDecision(false)}
                            >
                                <Text style={styles.actionText}>Cancel</Text>
                            </Pressable>
                            <Pressable
                                style={[styles.actionBtn, styles.approveBtn]}
                                onPress={() => handleApprovalDecision(true)}
                            >
                                <Text style={styles.actionText}>Approve</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#f4f6f9" },
    header: { padding: 16, backgroundColor: "#0f2942" },
    headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
    headerSub: { color: "#a9c2db", fontSize: 12, marginTop: 2 },
    chatArea: { flex: 1 },
    chatContent: { padding: 16, gap: 10 },
    bubble: { maxWidth: "82%", padding: 12, borderRadius: 14 },
    userBubble: { alignSelf: "flex-end", backgroundColor: "#1565c0" },
    assistantBubble: {
        alignSelf: "flex-start",
        backgroundColor: "#fff",
        borderWidth: 1,
        borderColor: "#e0e6ed",
    },
    userText: { color: "#fff", fontSize: 15 },
    assistantText: { color: "#1c242b", fontSize: 15 },
    inputBar: {
        flexDirection: "row",
        padding: 10,
        backgroundColor: "#fff",
        borderTopWidth: 1,
        borderColor: "#e0e6ed",
        gap: 8,
    },
    input: {
        flex: 1,
        backgroundColor: "#f0f3f7",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 15,
    },
    sendBtn: {
        backgroundColor: "#0f2942",
        borderRadius: 10,
        paddingHorizontal: 16,
        justifyContent: "center",
        alignItems: "center",
    },
    sendText: { color: "#fff", fontWeight: "600" },
    modalBackdrop: {
        flex: 1,
        backgroundColor: "rgba(0,0,0,0.45)",
        justifyContent: "center",
        alignItems: "center",
        padding: 20,
    },
    modalCard: {
        width: "100%",
        maxWidth: 420,
        backgroundColor: "#fff",
        borderRadius: 16,
        padding: 20,
        gap: 10,
    },
    modalTitle: { fontSize: 18, fontWeight: "700", color: "#0f2942" },
    modalBody: { fontSize: 15, color: "#222" },
    modalMeta: { fontSize: 13, color: "#555" },
    modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 8 },
    actionBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
    rejectBtn: { backgroundColor: "#b71c1c" },
    approveBtn: { backgroundColor: "#1b5e20" },
    actionText: { color: "#fff", fontWeight: "600" },
});
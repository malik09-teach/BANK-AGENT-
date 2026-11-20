import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const API_BASE_URL = Platform.OS === "android" ? "http://10.0.2.2:8000" : "http://127.0.0.1:8000";
const AUTH_TOKEN = "demo-user-1-token";

type TabType = "accounts" | "cards" | "fx_wire" | "copilot";

interface Account {
  account_id: string;
  name: string;
  account_type: string;
  balance: number;
  currency: string;
  iban: string;
  status: string;
}

interface CardData {
  card_id: string;
  account_id: string;
  card_number: string;
  cardholder_name: string;
  expiry: string;
  card_type: string;
  brand: string;
  status: string;
  spending_limit: number;
  currency: string;
}

interface Transaction {
  tx_id: string;
  account_id: string;
  merchant: string;
  category: string;
  amount: number;
  currency: string;
  status: string;
  created_at?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ApprovalPayload {
  type: string;
  from_account_id?: string;
  to_account_id?: string;
  amount?: number;
  currency?: string;
  from_currency?: string;
  to_currency?: string;
  recipient_name?: string;
  recipient_iban?: string;
  swift_code?: string;
  prompt: string;
  require_pin?: boolean;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cards, setCards] = useState<CardData[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [fxRates, setFxRates] = useState<Record<string, number>>({});
  const [loadingData, setLoadingData] = useState(false);

  // FX & Wire Form State
  const [fxSubTab, setFxSubTab] = useState<"convert" | "wire">("convert");
  const [fromAccId, setFromAccId] = useState("");
  const [toAccId, setToAccId] = useState("");
  const [convertAmount, setConvertAmount] = useState("");
  const [wireRecipient, setWireRecipient] = useState("");
  const [wireIban, setWireIban] = useState("");
  const [wireSwift, setWireSwift] = useState("");
  const [wireAmount, setWireAmount] = useState("");
  const [wireStatusMsg, setWireStatusMsg] = useState<string | null>(null);

  // Copilot Chat & SSE Stream State
  const threadIdRef = useRef<string>(`thread_${Date.now()}`);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hello Alex! I am your AI Banking Copilot. You can ask me to inspect your multi-currency balances, review recent spending, transfer funds, convert foreign currencies, or freeze your cards.",
    },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalPayload | null>(null);
  const [approvalPin, setApprovalPin] = useState("");

  // Load Bank Core Data
  const fetchBankData = async () => {
    setLoadingData(true);
    try {
      const headers = { Authorization: `Bearer ${AUTH_TOKEN}` };

      const [accRes, cardRes, txRes, fxRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/v1/accounts`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/cards`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/transactions`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/fx/rates`, { headers }),
      ]);

      if (accRes.ok) {
        const d = await accRes.json();
        setAccounts(d.accounts || []);
        if (d.accounts?.length >= 2) {
          setFromAccId(d.accounts[0].account_id);
          setToAccId(d.accounts[1].account_id);
        }
      }
      if (cardRes.ok) {
        const d = await cardRes.json();
        setCards(d.cards || []);
      }
      if (txRes.ok) {
        const d = await txRes.json();
        setTransactions(d.transactions || []);
      }
      if (fxRes.ok) {
        const d = await fxRes.json();
        setFxRates(d.rates || {});
      }
    } catch (err: any) {
      console.warn("Error loading banking data:", err.message);
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    fetchBankData();
  }, []);

  // Card Controls
  const handleToggleFreeze = async (cardId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/cards/${cardId}/toggle-freeze`, {
        method: "POST",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      const data = await res.json();
      if (res.ok) {
        setCards((prev) =>
          prev.map((c) => (c.card_id === cardId ? { ...c, status: data.status } : c))
        );
      } else {
        Alert.alert("Card Update Failed", data.detail || "Unable to update card status");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  };

  // FX Conversion Action
  const handleConvertFx = async () => {
    const amt = parseFloat(convertAmount);
    if (!amt || amt <= 0) {
      Alert.alert("Invalid Amount", "Please enter a valid amount to convert.");
      return;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/fx/convert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({
          from_account_id: fromAccId,
          to_account_id: toAccId,
          amount: amt,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        Alert.alert("Conversion Successful", data.message);
        setConvertAmount("");
        fetchBankData();
      } else {
        Alert.alert("Conversion Failed", data.detail || "Error converting funds");
      }
    } catch (err: any) {
      Alert.alert("Network Error", err.message);
    }
  };

  // SWIFT Wire Transfer Action
  const handleSendWire = async () => {
    const amt = parseFloat(wireAmount);
    if (!amt || amt <= 0 || !wireRecipient || !wireIban || !wireSwift) {
      Alert.alert("Missing Fields", "Please complete all recipient and wire details.");
      return;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/wires/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({
          from_account_id: fromAccId,
          recipient_name: wireRecipient,
          recipient_iban: wireIban,
          swift_code: wireSwift,
          amount: amt,
          currency: "USD",
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setWireStatusMsg(data.message);
        setWireRecipient("");
        setWireIban("");
        setWireSwift("");
        setWireAmount("");
        fetchBankData();
      } else {
        Alert.alert("SWIFT Wire Failed", data.detail || "Failed to submit wire.");
      }
    } catch (err: any) {
      Alert.alert("Network Error", err.message);
    }
  };

  // SSE Stream Consumer for Copilot
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
      throw new Error(`HTTP Error ${response.status}`);
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
    // Refresh core banking data in case agent performed transfers/status updates
    fetchBankData();
  };

  const handleSendChat = async (promptOverride?: string) => {
    const messageToSend = (promptOverride || chatInput).trim();
    if (!messageToSend || streaming) return;

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: "user",
      content: messageToSend,
    };
    const assistantMsgId = `a_${Date.now() + 1}`;

    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantMsgId, role: "assistant", content: "" },
    ]);
    if (!promptOverride) setChatInput("");
    setStreaming(true);

    try {
      await consumeSseStream(
        `${API_BASE_URL}/api/v1/agent/chat/stream`,
        { thread_id: threadIdRef.current, message: messageToSend },
        assistantMsgId
      );
    } catch (err: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: `Connection error: ${err?.message ?? "Server offline"}` }
            : m
        )
      );
    } finally {
      setStreaming(false);
    }
  };

  const handleApprovalDecision = async (approved: boolean) => {
    if (!pendingApproval || streaming) return;

    if (approved && pendingApproval.require_pin) {
      if (!approvalPin || approvalPin.trim().length !== 4) {
        Alert.alert("PIN Required", "Please enter your 4-digit Security PIN (Default: 1234) to authorize this transfer.");
        return;
      }
    }

    const pinToSend = approvalPin.trim();
    setPendingApproval(null);
    setApprovalPin("");
    setStreaming(true);

    const assistantMsgId = `a_confirm_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: "assistant", content: "" },
    ]);

    try {
      await consumeSseStream(
        `${API_BASE_URL}/api/v1/agent/confirm`,
        { thread_id: threadIdRef.current, approved, pin: pinToSend },
        assistantMsgId
      );
    } catch (err: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: `Approval error: ${err?.message ?? "Unknown error"}` }
            : m
        )
      );
    } finally {
      setStreaming(false);
    }
  };

  // Helper Total USD Calculation
  const totalUsdEquivalent = accounts.reduce((acc, a) => {
    if (a.currency === "USD") return acc + a.balance;
    const rate = fxRates[`${a.currency}/USD`] || 1.0;
    return acc + a.balance * rate;
  }, 0);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0b1329" />

      {/* Main App Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brandTitle}>AURA INTERNATIONAL BANK</Text>
          <Text style={styles.userSubtitle}>Client: Alex Morgan (Priority Global)</Text>
        </View>
        <Pressable style={styles.refreshBtn} onPress={fetchBankData}>
          <Text style={styles.refreshText}>{loadingData ? "..." : "↻"}</Text>
        </Pressable>
      </View>

      {/* Main Scrollable View */}
      <View style={styles.body}>
        {/* --- TAB 1: ACCOUNTS & DASHBOARD --- */}
        {activeTab === "accounts" && (
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* Total Net Worth Banner */}
            <View style={styles.netWorthCard}>
              <Text style={styles.netWorthLabel}>TOTAL LIQUID ASSETS (USD EQUIV.)</Text>
              <Text style={styles.netWorthValue}>
                ${totalUsdEquivalent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </Text>
              <View style={styles.currencyBadgeRow}>
                <View style={styles.curPill}><Text style={styles.curPillText}>USD: 2 Accounts</Text></View>
                <View style={styles.curPill}><Text style={styles.curPillText}>EUR: 1 Pocket</Text></View>
                <View style={styles.curPill}><Text style={styles.curPillText}>GBP: 1 Pocket</Text></View>
              </View>
            </View>

            {/* Quick Actions */}
            <View style={styles.quickActionRow}>
              <Pressable style={styles.actionCircle} onPress={() => setActiveTab("fx_wire")}>
                <Text style={styles.actionIcon}>⇄</Text>
                <Text style={styles.actionLabel}>Transfer</Text>
              </Pressable>
              <Pressable style={styles.actionCircle} onPress={() => { setActiveTab("fx_wire"); setFxSubTab("convert"); }}>
                <Text style={styles.actionIcon}>€/$</Text>
                <Text style={styles.actionLabel}>Convert FX</Text>
              </Pressable>
              <Pressable style={styles.actionCircle} onPress={() => { setActiveTab("fx_wire"); setFxSubTab("wire"); }}>
                <Text style={styles.actionIcon}>✈</Text>
                <Text style={styles.actionLabel}>SWIFT Wire</Text>
              </Pressable>
              <Pressable style={styles.actionCircle} onPress={() => setActiveTab("copilot")}>
                <Text style={styles.actionIcon}>⚡</Text>
                <Text style={styles.actionLabel}>AI Copilot</Text>
              </Pressable>
            </View>

            {/* Accounts Portfolio List */}
            <Text style={styles.sectionHeader}>Accounts & Multi-Currency Pockets</Text>
            {accounts.map((acc) => (
              <View key={acc.account_id} style={styles.accountCard}>
                <View style={styles.accountCardHeader}>
                  <View>
                    <Text style={styles.accountName}>{acc.name}</Text>
                    <Text style={styles.accountMeta}>
                      {acc.account_id} • {acc.iban || "Domestic Checking"}
                    </Text>
                  </View>
                  <View style={styles.currencyBadge}>
                    <Text style={styles.currencyBadgeText}>{acc.currency}</Text>
                  </View>
                </View>
                <Text style={styles.accountBalance}>
                  {acc.currency === "USD" ? "$" : acc.currency === "EUR" ? "€" : "£"}
                  {acc.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </Text>
              </View>
            ))}

            {/* Recent Transactions List */}
            <Text style={styles.sectionHeader}>Recent Transactions</Text>
            {transactions.slice(0, 6).map((tx) => (
              <View key={tx.tx_id} style={styles.txRow}>
                <View style={styles.txIconContainer}>
                  <Text style={styles.txCategoryIcon}>
                    {tx.category === "Income" ? "↓" : tx.category === "FX" ? "⇄" : tx.category === "Wire" ? "✈" : "↑"}
                  </Text>
                </View>
                <View style={styles.txInfo}>
                  <Text style={styles.txMerchant}>{tx.merchant}</Text>
                  <Text style={styles.txCategory}>{tx.category} • {tx.account_id}</Text>
                </View>
                <Text
                  style={[
                    styles.txAmount,
                    tx.amount > 0 ? styles.txCredit : styles.txDebit,
                  ]}
                >
                  {tx.amount > 0 ? "+" : ""}{tx.amount.toFixed(2)} {tx.currency}
                </Text>
              </View>
            ))}
            <View style={{ height: 20 }} />
          </ScrollView>
        )}

        {/* --- TAB 2: CARDS & LIMITS --- */}
        {activeTab === "cards" && (
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionHeader}>Managed Cards</Text>
            {cards.map((c) => (
              <View key={c.card_id} style={styles.cardContainer}>
                {/* Physical/Virtual Card Graphic */}
                <View
                  style={[
                    styles.cardVisual,
                    c.status === "frozen" ? styles.cardFrozenVisual : styles.cardActiveVisual,
                  ]}
                >
                  <View style={styles.cardVisualTop}>
                    <Text style={styles.cardBrand}>{c.brand.toUpperCase()}</Text>
                    <View
                      style={[
                        styles.cardStatusPill,
                        c.status === "frozen" ? styles.pillFrozen : styles.pillActive,
                      ]}
                    >
                      <Text style={styles.cardStatusText}>{c.status.toUpperCase()}</Text>
                    </View>
                  </View>
                  <Text style={styles.cardChip}>EMV CHIP ⧉</Text>
                  <Text style={styles.cardNumber}>{c.card_number}</Text>
                  <View style={styles.cardVisualBottom}>
                    <View>
                      <Text style={styles.cardHolderLabel}>CARDHOLDER</Text>
                      <Text style={styles.cardHolderName}>{c.cardholder_name}</Text>
                    </View>
                    <View>
                      <Text style={styles.cardHolderLabel}>EXPIRES</Text>
                      <Text style={styles.cardHolderName}>{c.expiry}</Text>
                    </View>
                  </View>
                </View>

                {/* Card Controls Panel */}
                <View style={styles.cardControlsCard}>
                  <View style={styles.cardControlRow}>
                    <View>
                      <Text style={styles.controlTitle}>Security Status</Text>
                      <Text style={styles.controlSub}>
                        {c.status === "active" ? "Card is active for all transactions." : "Card is locked & transactions declined."}
                      </Text>
                    </View>
                    <Pressable
                      style={[
                        styles.freezeBtn,
                        c.status === "active" ? styles.freezeBtnDanger : styles.freezeBtnUnlock,
                      ]}
                      onPress={() => handleToggleFreeze(c.card_id)}
                    >
                      <Text style={styles.freezeBtnText}>
                        {c.status === "active" ? "Freeze Card" : "Unfreeze"}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={styles.divider} />
                  <View style={styles.cardControlRow}>
                    <View>
                      <Text style={styles.controlTitle}>Monthly Spending Limit</Text>
                      <Text style={styles.controlSub}>
                        Max: ${c.spending_limit.toFixed(2)} {c.currency}
                      </Text>
                    </View>
                    <View style={styles.limitBarWrap}>
                      <View style={[styles.limitBarFill, { width: "45%" }]} />
                    </View>
                  </View>
                </View>
              </View>
            ))}
            <View style={{ height: 20 }} />
          </ScrollView>
        )}

        {/* --- TAB 3: FX & SWIFT WIRE TRANSFERS --- */}
        {activeTab === "fx_wire" && (
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* Sub-tab switcher */}
            <View style={styles.subTabContainer}>
              <Pressable
                style={[styles.subTabBtn, fxSubTab === "convert" && styles.subTabBtnActive]}
                onPress={() => setFxSubTab("convert")}
              >
                <Text style={[styles.subTabText, fxSubTab === "convert" && styles.subTabTextActive]}>
                  Foreign Exchange (FX)
                </Text>
              </Pressable>
              <Pressable
                style={[styles.subTabBtn, fxSubTab === "wire" && styles.subTabBtnActive]}
                onPress={() => setFxSubTab("wire")}
              >
                <Text style={[styles.subTabText, fxSubTab === "wire" && styles.subTabTextActive]}>
                  SWIFT International Wire
                </Text>
              </Pressable>
            </View>

            {/* Live FX Rates Matrix */}
            <View style={styles.ratesBox}>
              <Text style={styles.ratesBoxTitle}>Indicative Live Market FX Rates</Text>
              <View style={styles.ratesGrid}>
                {Object.entries(fxRates).slice(0, 6).map(([pair, rate]) => (
                  <View key={pair} style={styles.rateItem}>
                    <Text style={styles.ratePair}>{pair}</Text>
                    <Text style={styles.rateValue}>{rate.toFixed(4)}</Text>
                  </View>
                ))}
              </View>
            </View>

            {/* Instant Currency Conversion Form */}
            {fxSubTab === "convert" && (
              <View style={styles.formCard}>
                <Text style={styles.formTitle}>Instant Multi-Currency Conversion</Text>
                <Text style={styles.formHint}>Move funds between your pockets with zero markup fees.</Text>

                <Text style={styles.inputLabel}>Source Account (Pay from):</Text>
                <View style={styles.accountPickerRow}>
                  {accounts.map((a) => (
                    <Pressable
                      key={a.account_id}
                      style={[styles.accChoicePill, fromAccId === a.account_id && styles.accChoiceActive]}
                      onPress={() => setFromAccId(a.account_id)}
                    >
                      <Text style={[styles.accChoiceText, fromAccId === a.account_id && styles.accChoiceTextActive]}>
                        {a.name} ({a.currency})
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.inputLabel}>Destination Pocket (Receive in):</Text>
                <View style={styles.accountPickerRow}>
                  {accounts.map((a) => (
                    <Pressable
                      key={a.account_id}
                      style={[styles.accChoicePill, toAccId === a.account_id && styles.accChoiceActive]}
                      onPress={() => setToAccId(a.account_id)}
                    >
                      <Text style={[styles.accChoiceText, toAccId === a.account_id && styles.accChoiceTextActive]}>
                        {a.name} ({a.currency})
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.inputLabel}>Conversion Amount:</Text>
                <TextInput
                  style={styles.textInput}
                  keyboardType="numeric"
                  placeholder="e.g. 500.00"
                  placeholderTextColor="#8892b0"
                  value={convertAmount}
                  onChangeText={setConvertAmount}
                />

                <Pressable style={styles.submitBtn} onPress={handleConvertFx}>
                  <Text style={styles.submitBtnText}>Convert & Deposit Instantly</Text>
                </Pressable>
              </View>
            )}

            {/* SWIFT International Wire Form */}
            {fxSubTab === "wire" && (
              <View style={styles.formCard}>
                <Text style={styles.formTitle}>Send SWIFT Global Wire</Text>
                <Text style={styles.formHint}>Secure international telegraphic wire transfer.</Text>

                {wireStatusMsg && (
                  <View style={styles.statusSuccessBox}>
                    <Text style={styles.statusSuccessText}>{wireStatusMsg}</Text>
                  </View>
                )}

                <Text style={styles.inputLabel}>Recipient Full Legal / Business Name:</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="e.g. Hans Mueller / Berlin Trading GMBH"
                  placeholderTextColor="#8892b0"
                  value={wireRecipient}
                  onChangeText={setWireRecipient}
                />

                <Text style={styles.inputLabel}>Recipient International IBAN:</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="e.g. DE89370400440532013000"
                  placeholderTextColor="#8892b0"
                  value={wireIban}
                  onChangeText={setWireIban}
                  autoCapitalize="characters"
                />

                <Text style={styles.inputLabel}>SWIFT / BIC Bank Identifier:</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder="e.g. DEUTDEDBFXX"
                  placeholderTextColor="#8892b0"
                  value={wireSwift}
                  onChangeText={setWireSwift}
                  autoCapitalize="characters"
                />

                <Text style={styles.inputLabel}>Transfer Amount (USD):</Text>
                <TextInput
                  style={styles.textInput}
                  keyboardType="numeric"
                  placeholder="e.g. 2500.00"
                  placeholderTextColor="#8892b0"
                  value={wireAmount}
                  onChangeText={setWireAmount}
                />

                <Text style={styles.feeNotice}>* Fixed standard international wire routing fee: $15.00</Text>

                <Pressable style={styles.submitBtn} onPress={handleSendWire}>
                  <Text style={styles.submitBtnText}>Execute SWIFT Wire</Text>
                </Pressable>
              </View>
            )}
            <View style={{ height: 20 }} />
          </ScrollView>
        )}

        {/* --- TAB 4: LIVE AI COPILOT --- */}
        {activeTab === "copilot" && (
          <View style={styles.copilotContainer}>
            {/* Quick Prompt Chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              <Pressable
                style={styles.chip}
                onPress={() => handleSendChat("What are all my account balances?")}
              >
                <Text style={styles.chipText}>💰 Check Balances</Text>
              </Pressable>
              <Pressable
                style={styles.chip}
                onPress={() => handleSendChat("Show my recent transactions")}
              >
                <Text style={styles.chipText}>📄 Recent Spending</Text>
              </Pressable>
              <Pressable
                style={styles.chip}
                onPress={() => handleSendChat("Transfer $200 from Everyday Checking to High-Yield Vault")}
              >
                <Text style={styles.chipText}>⇄ Move $200</Text>
              </Pressable>
              <Pressable
                style={styles.chip}
                onPress={() => handleSendChat("Freeze my physical Visa card")}
              >
                <Text style={styles.chipText}>🔒 Freeze Visa</Text>
              </Pressable>
              <Pressable
                style={styles.chip}
                onPress={() => handleSendChat("What is the current EUR to USD exchange rate?")}
              >
                <Text style={styles.chipText}>💱 FX Rates</Text>
              </Pressable>
            </ScrollView>

            {/* Conversation Messages */}
            <ScrollView style={styles.chatArea} contentContainerStyle={styles.chatContent}>
              {messages.map((m) => (
                <View
                  key={m.id}
                  style={[
                    styles.chatBubble,
                    m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant,
                  ]}
                >
                  <Text style={m.role === "user" ? styles.userChatText : styles.assistantChatText}>
                    {m.content || (streaming ? "Thinking & coordinating tools..." : "")}
                  </Text>
                </View>
              ))}
            </ScrollView>

            {/* Chat Input Bar */}
            <View style={styles.chatInputBar}>
              <TextInput
                style={styles.chatTextInput}
                placeholder="Instruct your banking copilot..."
                placeholderTextColor="#8892b0"
                value={chatInput}
                onChangeText={setChatInput}
                onSubmitEditing={() => handleSendChat()}
                editable={!streaming}
              />
              <Pressable
                style={[styles.chatSendBtn, streaming && styles.chatSendBtnDisabled]}
                onPress={() => handleSendChat()}
                disabled={streaming}
              >
                {streaming ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.chatSendText}>Send</Text>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* --- HITL APPROVAL MODAL --- */}
      <Modal visible={Boolean(pendingApproval)} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalBadge}>SECURITY INTERRUPT</Text>
              <Text style={styles.modalActionType}>{pendingApproval?.type?.toUpperCase()}</Text>
            </View>

            <Text style={styles.modalPrompt}>{pendingApproval?.prompt}</Text>

            <View style={styles.modalDetailsBox}>
              {pendingApproval?.amount && (
                <Text style={styles.modalDetailItem}>
                  Amount: ${pendingApproval.amount.toFixed(2)} {pendingApproval.currency || pendingApproval.from_currency}
                </Text>
              )}
              {pendingApproval?.from_account_id && (
                <Text style={styles.modalDetailItem}>Source: {pendingApproval.from_account_id}</Text>
              )}
              {pendingApproval?.to_account_id && (
                <Text style={styles.modalDetailItem}>Target: {pendingApproval.to_account_id}</Text>
              )}
              {pendingApproval?.recipient_name && (
                <Text style={styles.modalDetailItem}>Recipient: {pendingApproval.recipient_name}</Text>
              )}
              {pendingApproval?.swift_code && (
                <Text style={styles.modalDetailItem}>SWIFT/BIC: {pendingApproval.swift_code}</Text>
              )}
            </View>

            {pendingApproval?.require_pin && (
              <View style={styles.pinSection}>
                <Text style={styles.pinLabel}>ENTER 4-DIGIT SECURITY PIN</Text>
                <TextInput
                  style={styles.pinInput}
                  placeholder="••••"
                  placeholderTextColor="#64748b"
                  value={approvalPin}
                  onChangeText={setApprovalPin}
                  keyboardType="numeric"
                  maxLength={4}
                  secureTextEntry
                  autoFocus
                />
                <Text style={styles.pinHint}>Default demo security PIN: 1234</Text>
              </View>
            )}

            <View style={styles.modalBtnRow}>
              <Pressable
                style={[styles.modalBtn, styles.modalRejectBtn]}
                onPress={() => handleApprovalDecision(false)}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalApproveBtn]}
                onPress={() => handleApprovalDecision(true)}
              >
                <Text style={styles.modalBtnText}>Authorize</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* --- BOTTOM NAVIGATION BAR --- */}
      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tabItem, activeTab === "accounts" && styles.tabItemActive]}
          onPress={() => setActiveTab("accounts")}
        >
          <Text style={styles.tabIcon}>🏦</Text>
          <Text style={[styles.tabLabel, activeTab === "accounts" && styles.tabLabelActive]}>
            Accounts
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabItem, activeTab === "cards" && styles.tabItemActive]}
          onPress={() => setActiveTab("cards")}
        >
          <Text style={styles.tabIcon}>💳</Text>
          <Text style={[styles.tabLabel, activeTab === "cards" && styles.tabLabelActive]}>Cards</Text>
        </Pressable>

        <Pressable
          style={[styles.tabItem, activeTab === "fx_wire" && styles.tabItemActive]}
          onPress={() => setActiveTab("fx_wire")}
        >
          <Text style={styles.tabIcon}>💱</Text>
          <Text style={[styles.tabLabel, activeTab === "fx_wire" && styles.tabLabelActive]}>
            FX & Wire
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabItem, activeTab === "copilot" && styles.tabItemActive]}
          onPress={() => setActiveTab("copilot")}
        >
          <Text style={styles.tabIcon}>⚡</Text>
          <Text style={[styles.tabLabel, activeTab === "copilot" && styles.tabLabelActive]}>
            AI Copilot
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#080e1e",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: "#0d182e",
    borderBottomWidth: 1,
    borderBottomColor: "#1a2c50",
  },
  brandTitle: {
    color: "#64ffda",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  userSubtitle: {
    color: "#8892b0",
    fontSize: 12,
    marginTop: 2,
  },
  refreshBtn: {
    padding: 8,
    backgroundColor: "#162744",
    borderRadius: 8,
  },
  refreshText: {
    color: "#64ffda",
    fontSize: 18,
    fontWeight: "bold",
  },
  body: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  netWorthCard: {
    backgroundColor: "linear-gradient(135deg, #162a52, #0d1a33)",
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#233966",
    marginBottom: 16,
  },
  netWorthLabel: {
    color: "#8892b0",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.1,
  },
  netWorthValue: {
    color: "#ffffff",
    fontSize: 32,
    fontWeight: "800",
    marginTop: 6,
    marginBottom: 12,
  },
  currencyBadgeRow: {
    flexDirection: "row",
    gap: 8,
  },
  curPill: {
    backgroundColor: "#1c325c",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  curPillText: {
    color: "#ccd6f6",
    fontSize: 11,
    fontWeight: "600",
  },
  quickActionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  actionCircle: {
    alignItems: "center",
    flex: 1,
  },
  actionIcon: {
    backgroundColor: "#162a52",
    width: 52,
    height: 52,
    borderRadius: 26,
    textAlign: "center",
    lineHeight: 50,
    color: "#64ffda",
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "#2b467e",
  },
  actionLabel: {
    color: "#ccd6f6",
    fontSize: 12,
    fontWeight: "500",
  },
  sectionHeader: {
    color: "#ccd6f6",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
    marginTop: 6,
  },
  accountCard: {
    backgroundColor: "#101d36",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1e335a",
  },
  accountCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  accountName: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  accountMeta: {
    color: "#8892b0",
    fontSize: 12,
    marginTop: 3,
  },
  currencyBadge: {
    backgroundColor: "#1c3b6f",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  currencyBadgeText: {
    color: "#64ffda",
    fontWeight: "700",
    fontSize: 12,
  },
  accountBalance: {
    color: "#64ffda",
    fontSize: 22,
    fontWeight: "800",
    marginTop: 10,
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#101d36",
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#182a4a",
  },
  txIconContainer: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#162744",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  txCategoryIcon: {
    color: "#64ffda",
    fontSize: 18,
    fontWeight: "bold",
  },
  txInfo: {
    flex: 1,
  },
  txMerchant: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  txCategory: {
    color: "#8892b0",
    fontSize: 11,
    marginTop: 2,
  },
  txAmount: {
    fontSize: 14,
    fontWeight: "700",
  },
  txDebit: {
    color: "#ff6b6b",
  },
  txCredit: {
    color: "#51cf66",
  },
  cardContainer: {
    marginBottom: 20,
  },
  cardVisual: {
    borderRadius: 18,
    padding: 22,
    minHeight: 185,
    justifyContent: "space-between",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  cardActiveVisual: {
    backgroundColor: "#13315c",
    borderWidth: 1,
    borderColor: "#2a599b",
  },
  cardFrozenVisual: {
    backgroundColor: "#3a404d",
    borderWidth: 1,
    borderColor: "#60697b",
  },
  cardVisualTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardBrand: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 2,
  },
  cardStatusPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  pillActive: {
    backgroundColor: "#1b5e20",
  },
  pillFrozen: {
    backgroundColor: "#d32f2f",
  },
  cardStatusText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
  cardChip: {
    color: "#ffd700",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 10,
  },
  cardNumber: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 3,
    marginTop: 10,
  },
  cardVisualBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 14,
  },
  cardHolderLabel: {
    color: "#8892b0",
    fontSize: 9,
    fontWeight: "700",
  },
  cardHolderName: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
    marginTop: 2,
  },
  cardControlsCard: {
    backgroundColor: "#101d36",
    borderRadius: 14,
    padding: 16,
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#1e335a",
  },
  cardControlRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  controlTitle: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  controlSub: {
    color: "#8892b0",
    fontSize: 12,
    marginTop: 2,
  },
  freezeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  freezeBtnDanger: {
    backgroundColor: "#b71c1c",
  },
  freezeBtnUnlock: {
    backgroundColor: "#2e7d32",
  },
  freezeBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  divider: {
    height: 1,
    backgroundColor: "#1a2c50",
    marginVertical: 12,
  },
  limitBarWrap: {
    width: 80,
    height: 8,
    backgroundColor: "#1a2c50",
    borderRadius: 4,
    overflow: "hidden",
  },
  limitBarFill: {
    height: "100%",
    backgroundColor: "#64ffda",
  },
  subTabContainer: {
    flexDirection: "row",
    backgroundColor: "#0d182e",
    borderRadius: 10,
    padding: 4,
    marginBottom: 16,
  },
  subTabBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 8,
  },
  subTabBtnActive: {
    backgroundColor: "#1e3768",
  },
  subTabText: {
    color: "#8892b0",
    fontSize: 13,
    fontWeight: "600",
  },
  subTabTextActive: {
    color: "#64ffda",
    fontWeight: "700",
  },
  ratesBox: {
    backgroundColor: "#101d36",
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#1e335a",
  },
  ratesBoxTitle: {
    color: "#8892b0",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 10,
    letterSpacing: 0.8,
  },
  ratesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  rateItem: {
    backgroundColor: "#162744",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    width: "31%",
  },
  ratePair: {
    color: "#ccd6f6",
    fontSize: 11,
    fontWeight: "600",
  },
  rateValue: {
    color: "#64ffda",
    fontSize: 14,
    fontWeight: "700",
    marginTop: 2,
  },
  formCard: {
    backgroundColor: "#101d36",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e335a",
  },
  formTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
  formHint: {
    color: "#8892b0",
    fontSize: 12,
    marginTop: 2,
    marginBottom: 14,
  },
  inputLabel: {
    color: "#ccd6f6",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 10,
    marginBottom: 6,
  },
  accountPickerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 6,
  },
  accChoicePill: {
    backgroundColor: "#162744",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#233966",
  },
  accChoiceActive: {
    backgroundColor: "#1e3d74",
    borderColor: "#64ffda",
  },
  accChoiceText: {
    color: "#8892b0",
    fontSize: 11,
    fontWeight: "600",
  },
  accChoiceTextActive: {
    color: "#64ffda",
    fontWeight: "700",
  },
  textInput: {
    backgroundColor: "#162744",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#ffffff",
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#233966",
  },
  feeNotice: {
    color: "#8892b0",
    fontSize: 11,
    marginTop: 8,
  },
  statusSuccessBox: {
    backgroundColor: "#163828",
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#2e7d32",
  },
  statusSuccessText: {
    color: "#a3e635",
    fontSize: 13,
  },
  submitBtn: {
    backgroundColor: "#64ffda",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 16,
  },
  submitBtnText: {
    color: "#080e1e",
    fontWeight: "800",
    fontSize: 14,
  },
  copilotContainer: {
    flex: 1,
  },
  chipRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxHeight: 52,
  },
  chip: {
    backgroundColor: "#162744",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: 8,
    borderWidth: 1,
    borderColor: "#243c68",
  },
  chipText: {
    color: "#ccd6f6",
    fontSize: 12,
    fontWeight: "600",
  },
  chatArea: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    gap: 12,
  },
  chatBubble: {
    maxWidth: "85%",
    padding: 14,
    borderRadius: 14,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "#1a4980",
  },
  bubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: "#101d36",
    borderWidth: 1,
    borderColor: "#1e335a",
  },
  userChatText: {
    color: "#ffffff",
    fontSize: 14,
    lineHeight: 20,
  },
  assistantChatText: {
    color: "#ccd6f6",
    fontSize: 14,
    lineHeight: 20,
  },
  chatInputBar: {
    flexDirection: "row",
    padding: 12,
    backgroundColor: "#0d182e",
    borderTopWidth: 1,
    borderTopColor: "#1a2c50",
    gap: 8,
  },
  chatTextInput: {
    flex: 1,
    backgroundColor: "#162744",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#ffffff",
    fontSize: 14,
  },
  chatSendBtn: {
    backgroundColor: "#64ffda",
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  chatSendBtnDisabled: {
    opacity: 0.6,
  },
  chatSendText: {
    color: "#080e1e",
    fontWeight: "800",
    fontSize: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#0f1c36",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#234177",
  },
  modalHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalBadge: {
    backgroundColor: "#d32f2f",
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  modalActionType: {
    color: "#64ffda",
    fontSize: 12,
    fontWeight: "700",
  },
  modalPrompt: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 22,
    marginBottom: 14,
  },
  modalDetailsBox: {
    backgroundColor: "#162744",
    borderRadius: 10,
    padding: 12,
    gap: 6,
    marginBottom: 16,
  },
  modalDetailItem: {
    color: "#ccd6f6",
    fontSize: 12,
    fontWeight: "500",
  },
  pinSection: {
    backgroundColor: "#0d1a33",
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#234177",
    marginBottom: 16,
    alignItems: "center",
  },
  pinLabel: {
    color: "#64ffda",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  pinInput: {
    backgroundColor: "#162744",
    borderRadius: 8,
    width: "70%",
    paddingVertical: 10,
    paddingHorizontal: 16,
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: 8,
    borderWidth: 1,
    borderColor: "#64ffda",
  },
  pinHint: {
    color: "#8892b0",
    fontSize: 11,
    marginTop: 6,
  },
  modalBtnRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
  },
  modalBtn: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  modalRejectBtn: {
    backgroundColor: "#b71c1c",
  },
  modalApproveBtn: {
    backgroundColor: "#2e7d32",
  },
  modalBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 13,
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#0d182e",
    borderTopWidth: 1,
    borderTopColor: "#1a2c50",
    paddingVertical: 8,
    paddingBottom: Platform.OS === "ios" ? 22 : 8,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 4,
  },
  tabItemActive: {
    borderTopWidth: 2,
    borderTopColor: "#64ffda",
  },
  tabIcon: {
    fontSize: 18,
    marginBottom: 2,
  },
  tabLabel: {
    color: "#8892b0",
    fontSize: 11,
    fontWeight: "600",
  },
  tabLabelActive: {
    color: "#64ffda",
    fontWeight: "700",
  },
});

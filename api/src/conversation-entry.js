const timestamp = value => {
  const parsed = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function activityAt(conversation) {
  const explicitActivity = timestamp(conversation.lastActivityAt);
  if (explicitActivity !== null) return explicitActivity;

  // Older adapters do not expose lastActivityAt. A reopened chat can contain
  // messages newer than its recorded close, so inspect both without sorting.
  let latest = timestamp(conversation.endedAt);
  for (const message of conversation.messages || []) {
    const sentAt = timestamp(message.timestamp);
    if (sentAt !== null && (latest === null || sentAt > latest)) latest = sentAt;
  }
  return latest ?? timestamp(conversation.startedAt) ?? -Infinity;
}

export function selectConversationEntry(conversations, preferredId) {
  const preferred = preferredId && conversations.find(conversation => conversation.id === preferredId);
  if (preferred) return preferred.id;

  let selected = null;
  let latest = -Infinity;
  for (const conversation of conversations) {
    const activity = activityAt(conversation);
    if (!selected || activity > latest || (activity === latest && conversation.id < selected.id)) {
      selected = conversation;
      latest = activity;
    }
  }
  return selected?.id ?? null;
}

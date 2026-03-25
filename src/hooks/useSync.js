import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DELIVERY_RELIABLE, EVENT_RAW } from '../lib/mistlib/index.js';
import { readDeviceId } from '../utils/device.js';
import { getMistNode } from '../utils/mist.js';

const ROOM_QUERY_KEY = 'room';
const ROOM_PREFIX = 'pdf-sync-';
const BROADCAST_GRACE_MS = 500;
const PRESENCE_EVENT_TYPES = new Set([2, 3, 4]);

function readInitialRoomId() {
  const queryRoom = new URLSearchParams(window.location.search).get(ROOM_QUERY_KEY)?.trim();
  return queryRoom ?? '';
}

function buildInviteUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set(ROOM_QUERY_KEY, roomId);
  url.hash = '';
  return url.toString();
}

function buildTransportRoomId(roomId) {
  return `${ROOM_PREFIX}${roomId}`;
}

function serializeState(state) {
  return JSON.stringify(state);
}

function readPeerCount(node, selfId) {
  const allNodes = node.getAllNodes();
  if (!Array.isArray(allNodes) || allNodes.length === 0) return 0;

  const isSelfNode = (value) => {
    if (!value || typeof value !== 'object') return false;
    const candidate = value;
    return [candidate.id, candidate.nodeId, candidate.deviceId, candidate.fromId].some(
      (entry) => entry === selfId,
    );
  };

  const peers = allNodes.filter((entry) => !isSelfNode(entry));
  return Math.max(0, peers.length);
}

export function useSync({
  state,
  onReplaceState,
  isEditing,
}) {
  const deviceId = useMemo(() => readDeviceId(), []);
  const initialRoomId = useMemo(() => readInitialRoomId(), []);
  const [roomId, setRoomId] = useState(initialRoomId);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [acceptRemoteStateValue, setAcceptRemoteStateValue] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [hasRemoteStateDiff, setHasRemoteStateDiff] = useState(false);

  const nodeRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const isEditingRef = useRef(isEditing);
  isEditingRef.current = isEditing;
  
  const lastSentSignatureRef = useRef('');
  const pendingRemoteSignatureRef = useRef(null);
  const readyToBroadcastRef = useRef(false);
  const broadcastTimerRef = useRef(null);
  const queuedSnapshotRef = useRef(null);
  const lastRemoteSnapshotRef = useRef(null);

  const activeRoomIdRef = useRef('');
  const connectingRoomIdRef = useRef('');
  const connectSessionRef = useRef(0);
  const acceptRemoteStateRef = useRef(acceptRemoteStateValue);
  acceptRemoteStateRef.current = acceptRemoteStateValue;

  const onReplaceStateRef = useRef(onReplaceState);
  onReplaceStateRef.current = onReplaceState;

  useEffect(() => {
    const remoteSnapshot = lastRemoteSnapshotRef.current;
    if (!remoteSnapshot || acceptRemoteStateValue) {
      setHasRemoteStateDiff(false);
      return;
    }

    const currentSignature = serializeState(state);
    const remoteSignature = serializeState(remoteSnapshot.state);
    setHasRemoteStateDiff(currentSignature !== remoteSignature);
  }, [acceptRemoteStateValue, state]);

  useEffect(() => {
    const nextUrl = new URL(window.location.href);
    const shouldShowInUrl = roomId && (status === 'connected' || status === 'connecting');

    if (!shouldShowInUrl) {
      if (nextUrl.searchParams.has(ROOM_QUERY_KEY)) {
        nextUrl.searchParams.delete(ROOM_QUERY_KEY);
        window.history.replaceState({}, '', nextUrl.toString());
      }
      return;
    }

    if (nextUrl.searchParams.get(ROOM_QUERY_KEY) !== roomId) {
      nextUrl.searchParams.set(ROOM_QUERY_KEY, roomId);
      window.history.replaceState({}, '', nextUrl.toString());
    }
  }, [roomId, status]);

  const sendMessage = useCallback((message) => {
    const node = nodeRef.current;
    if (!node) return;
    node.sendMessage('', message, DELIVERY_RELIABLE);
  }, []);

  const makeSnapshot = useCallback((updatedAt = Date.now()) => {
    return {
      version: 1,
      roomId: activeRoomIdRef.current,
      updatedAt,
      state: stateRef.current,
    };
  }, []);

  const sendCurrentSnapshot = useCallback(() => {
    const currentRoomId = activeRoomIdRef.current;
    if (!currentRoomId) return;
    const snapshot = makeSnapshot();
    const signature = serializeState(snapshot.state);
    lastSentSignatureRef.current = signature;
    queuedSnapshotRef.current = null;

    sendMessage({
      type: 'snapshot',
      roomId: currentRoomId,
      from: deviceId,
      snapshot,
    });
  }, [deviceId, makeSnapshot, sendMessage]);

  const flushQueuedSnapshot = useCallback(() => {
    if (!readyToBroadcastRef.current || !queuedSnapshotRef.current) return;
    const snapshot = queuedSnapshotRef.current;
    const signature = serializeState(snapshot.state);
    if (signature === lastSentSignatureRef.current) {
      queuedSnapshotRef.current = null;
      return;
    }

    lastSentSignatureRef.current = signature;
    queuedSnapshotRef.current = null;
    sendMessage({
      type: 'snapshot',
      roomId: snapshot.roomId,
      from: deviceId,
      snapshot,
    });
  }, [deviceId, sendMessage]);

  const handleIncomingMessage = useCallback(
    (fromId, payload) => {
      let parsed = null;
      try {
        const text = new TextDecoder().decode(payload);
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      const activeRoomId = activeRoomIdRef.current;
      if (!parsed || parsed.roomId !== activeRoomId) return;
      if (parsed.from === deviceId) return;

      if (parsed.type === 'request-snapshot') {
        if (!readyToBroadcastRef.current) {
          queuedSnapshotRef.current = makeSnapshot();
          return;
        }
        sendCurrentSnapshot();
        return;
      }

      if (parsed.type === 'accept-settings') {
        sendCurrentSnapshot();
        setAcceptRemoteStateValue(true);
        return;
      }

      if (parsed.type !== 'snapshot') return;
      if (parsed.snapshot.version !== 1) return;

      if (isEditingRef.current) return;

      const signature = serializeState(parsed.snapshot.state);
      lastRemoteSnapshotRef.current = parsed.snapshot;
      const currentSignature = serializeState(stateRef.current);
      const nextStateDiff = currentSignature !== signature;

      if (!nextStateDiff || acceptRemoteStateRef.current) {
        queuedSnapshotRef.current = null;
      }

      readyToBroadcastRef.current = true;
      setStatus('connected');
      
      if (acceptRemoteStateRef.current) {
        if (nextStateDiff) {
          pendingRemoteSignatureRef.current = signature;
          onReplaceStateRef.current(parsed.snapshot.state);
        }
        setHasRemoteStateDiff(false);
      } else {
        setHasRemoteStateDiff(nextStateDiff);
        if (!nextStateDiff) {
          setAcceptRemoteStateValue(true);
        }
      }
    },
    [deviceId, makeSnapshot, sendCurrentSnapshot],
  );

  const stopCurrentConnection = useCallback(() => {
    readyToBroadcastRef.current = false;
    queuedSnapshotRef.current = null;
    lastRemoteSnapshotRef.current = null;
    setHasRemoteStateDiff(false);
    activeRoomIdRef.current = '';
    connectingRoomIdRef.current = '';
    setPeerCount(0);

    const currentNode = nodeRef.current;
    nodeRef.current = null;
    if (currentNode) {
      currentNode.leaveRoom();
    }
  }, []);

  const clearBroadcastTimer = useCallback(() => {
    if (broadcastTimerRef.current !== null) {
      window.clearTimeout(broadcastTimerRef.current);
      broadcastTimerRef.current = null;
    }
  }, []);

  const connectToRoom = useCallback(async (targetRoomId) => {
    const normalizedRoomId = targetRoomId.trim();
    if (!normalizedRoomId) return;
    if (activeRoomIdRef.current === normalizedRoomId) return;

    connectSessionRef.current += 1;
    const sessionId = connectSessionRef.current;

    stopCurrentConnection();
    setAcceptRemoteStateValue(false);
    setStatus('connecting');
    setError('');
    connectingRoomIdRef.current = normalizedRoomId;

    try {
      const node = await getMistNode();
      nodeRef.current = node;

      if (sessionId !== connectSessionRef.current) return;

      node.onEvent((eventType, fromId, payload) => {
        if (eventType === EVENT_RAW) {
          handleIncomingMessage(fromId, payload);
          return;
        }

        if (PRESENCE_EVENT_TYPES.has(eventType)) {
          const count = readPeerCount(node, deviceId);
          setPeerCount(count);
          if (eventType === 2) {
            sendCurrentSnapshot();
          }
        }
      });

      node.joinRoom(buildTransportRoomId(normalizedRoomId));
      activeRoomIdRef.current = normalizedRoomId;
      setStatus('connected');
      setPeerCount(readPeerCount(node, deviceId));

      window.setTimeout(() => {
        if (sessionId !== connectSessionRef.current) return;
        sendMessage({
          type: 'request-snapshot',
          roomId: normalizedRoomId,
          from: deviceId,
        });
      }, 100);

      clearBroadcastTimer();
      queuedSnapshotRef.current = makeSnapshot();
      broadcastTimerRef.current = window.setTimeout(() => {
        if (sessionId !== connectSessionRef.current) return;
        readyToBroadcastRef.current = true;
        flushQueuedSnapshot();
      }, BROADCAST_GRACE_MS);
    } catch (err) {
      if (sessionId !== connectSessionRef.current) return;
      setStatus('error');
      setError(err.message || '同期に失敗しました。');
      stopCurrentConnection();
    } finally {
      if (sessionId === connectSessionRef.current) {
        connectingRoomIdRef.current = '';
      }
    }
  }, [deviceId, handleIncomingMessage, makeSnapshot, sendMessage, stopCurrentConnection, clearBroadcastTimer, flushQueuedSnapshot]);

  useEffect(() => {
    if (!initialRoomId) return;
    connectToRoom(initialRoomId);
  }, [connectToRoom, initialRoomId]);

  useEffect(() => {
    return () => stopCurrentConnection();
  }, [stopCurrentConnection]);

  useEffect(() => {
    if (!roomId) return;
    if (status !== 'connected') return;

    const signature = serializeState(state);
    if (signature === lastSentSignatureRef.current) return;

    if (pendingRemoteSignatureRef.current !== null) {
      lastSentSignatureRef.current = signature;
      if (signature === pendingRemoteSignatureRef.current) {
        pendingRemoteSignatureRef.current = null;
      }
      return;
    }

    const snapshot = makeSnapshot();
    if (!readyToBroadcastRef.current) {
      queuedSnapshotRef.current = snapshot;
      return;
    }

    queuedSnapshotRef.current = null;
    lastSentSignatureRef.current = signature;
    sendMessage({
      type: 'snapshot',
      roomId,
      from: deviceId,
      snapshot,
    });
  }, [deviceId, makeSnapshot, roomId, sendMessage, state, status]);

  const setAcceptRemoteState = useCallback((next) => {
    setAcceptRemoteStateValue((current) => {
      if (next && !current) {
        if (lastRemoteSnapshotRef.current) {
          pendingRemoteSignatureRef.current = serializeState(lastRemoteSnapshotRef.current.state);
          onReplaceStateRef.current(lastRemoteSnapshotRef.current.state);
          setHasRemoteStateDiff(false);
        }
        if (roomId && status === 'connected') {
          sendMessage({
            type: 'accept-settings',
            roomId,
            from: deviceId,
          });
        }
      }
      return next;
    });
  }, [deviceId, roomId, sendMessage, status]);

  const startSync = useCallback(() => {
    const nextRoomId = roomId || crypto.randomUUID();
    setRoomId(nextRoomId);
    connectToRoom(nextRoomId);
    return nextRoomId;
  }, [connectToRoom, roomId]);

  const disconnect = useCallback(() => {
    stopCurrentConnection();
    setStatus('idle');
  }, [stopCurrentConnection]);

  const copyInviteLink = useCallback(async () => {
    const nextRoomId = roomId || startSync();
    const url = buildInviteUrl(nextRoomId);
    try {
      await navigator.clipboard.writeText(url);
      return url;
    } catch (err) {
      console.error('Clipboard failed', err);
      return url;
    }
  }, [roomId, startSync]);

  return {
    roomId,
    inviteUrl: roomId ? buildInviteUrl(roomId) : '',
    status,
    error,
    acceptRemoteState: acceptRemoteStateValue,
    setAcceptRemoteState,
    peerCount,
    hasRemoteStateDiff,
    startSync,
    copyInviteLink,
    disconnect,
  };
}

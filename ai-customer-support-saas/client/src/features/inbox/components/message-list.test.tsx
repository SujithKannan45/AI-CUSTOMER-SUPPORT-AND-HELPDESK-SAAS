import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeMessage, TEST_MESSAGE_ID } from '@/test/fixtures';
import { MessageList } from './message-list';

// Reduced-motion users get the same content: the component must not hide or
// delay anything behind an animation.
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<object>('framer-motion');
  return { ...actual, useReducedMotion: () => true };
});

describe('MessageList', () => {
  it('renders sender, time and body as text', () => {
    render(
      <MessageList
        messages={[makeMessage()]}
        currentUserId={null}
        hasEarlier={false}
        loadingEarlier={false}
        onLoadEarlier={() => undefined}
      />,
    );

    expect(screen.getByText('Agent #439031')).toBeInTheDocument();
    expect(screen.getByText('Thanks for reaching out — checking the invoice now.')).toBeInTheDocument();
    expect(screen.getByText(/Sep 5, 2026/)).toBeInTheDocument();
  });

  it('labels the signed-in agent as You', () => {
    render(
      <MessageList
        messages={[makeMessage({ senderId: 'user-1' })]}
        currentUserId="user-1"
        hasEarlier={false}
        loadingEarlier={false}
        onLoadEarlier={() => undefined}
      />,
    );

    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('marks internal notes as staff-only', () => {
    render(
      <MessageList
        messages={[
          makeMessage({
            id: TEST_MESSAGE_ID,
            visibility: 'INTERNAL',
            body: 'Finance confirmed the refund reference.',
          }),
        ]}
        currentUserId={null}
        hasEarlier={false}
        loadingEarlier={false}
        onLoadEarlier={() => undefined}
      />,
    );

    expect(screen.getAllByText('Internal note · staff only').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Internal note from Agent/)).toBeInTheDocument();
  });

  it('renders attachment references by filename', () => {
    render(
      <MessageList
        messages={[
          makeMessage({
            attachments: [
              { fileKey: 'files/invoice.pdf', filename: 'invoice.pdf', sizeBytes: 2048, mimeType: 'application/pdf' },
            ],
          }),
        ]}
        currentUserId={null}
        hasEarlier={false}
        loadingEarlier={false}
        onLoadEarlier={() => undefined}
      />,
    );

    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('offers the earlier page only when the server reports one', () => {
    const { rerender } = render(
      <MessageList
        messages={[makeMessage()]}
        currentUserId={null}
        hasEarlier
        loadingEarlier={false}
        onLoadEarlier={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeInTheDocument();

    rerender(
      <MessageList
        messages={[makeMessage()]}
        currentUserId={null}
        hasEarlier={false}
        loadingEarlier={false}
        onLoadEarlier={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  it('shows an empty state for a conversation with no messages', () => {
    render(
      <MessageList
        messages={[]}
        currentUserId={null}
        hasEarlier={false}
        loadingEarlier={false}
        onLoadEarlier={() => undefined}
      />,
    );

    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });
});

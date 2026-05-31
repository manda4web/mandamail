import { describe, it, expect } from 'vitest';
import { parseRaw, cleanHtml, htmlToText } from '../../imap/EmailParser.js';

describe('EmailParser', () => {
  describe('parseRaw', () => {
    it('should extract all fields from a complete parsed email', () => {
      const parsed = {
        messageId: '<test-123@example.com>',
        from: { value: [{ address: 'John@Example.com', name: 'John Doe' }] },
        replyTo: { value: [{ address: 'reply@example.com' }] },
        subject: 'Test Subject',
        html: '<p>Hello World</p>',
        text: 'Hello World',
        to: { value: [{ address: 'recipient@example.com' }] },
        cc: { value: [{ address: 'cc1@example.com' }, { address: 'cc2@example.com' }] },
        attachments: [
          {
            filename: 'doc.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('pdf-content'),
            contentDisposition: 'attachment',
          },
        ],
        date: new Date('2024-01-15T10:00:00Z'),
      };

      const result = parseRaw(parsed);

      expect(result.messageId).toBe('<test-123@example.com>');
      expect(result.fromEmail).toBe('john@example.com');
      expect(result.fromName).toBe('John Doe');
      expect(result.replyTo).toBe('reply@example.com');
      expect(result.subject).toBe('Test Subject');
      expect(result.bodyHtml).toContain('Hello World');
      expect(result.bodyText).toBe('Hello World');
      expect(result.toEmails).toEqual(['recipient@example.com']);
      expect(result.ccEmails).toEqual(['cc1@example.com', 'cc2@example.com']);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].fileName).toBe('doc.pdf');
      expect(result.attachments[0].mimeType).toBe('application/pdf');
      expect(result.attachments[0].fileData).toBe(Buffer.from('pdf-content').toString('base64'));
      expect(result.attachmentCount).toBe(1);
      expect(result.date).toEqual(new Date('2024-01-15T10:00:00Z'));
    });

    it('should throw error when messageId is missing', () => {
      const parsed = {
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
        subject: 'Test',
      };

      expect(() => parseRaw(parsed)).toThrow('missing message_id');
    });

    it('should throw error when from_email is missing', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [] },
        subject: 'Test',
      };

      expect(() => parseRaw(parsed)).toThrow('missing from_email');
    });

    it('should use email local part as fromName when name is missing', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'john.doe@example.com' }] },
        subject: 'Test',
      };

      const result = parseRaw(parsed);
      expect(result.fromName).toBe('john.doe');
    });

    it('should fallback replyTo to fromEmail when replyTo is missing', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'sender@example.com', name: 'Sender' }] },
        subject: 'Test',
      };

      const result = parseRaw(parsed);
      expect(result.replyTo).toBe('sender@example.com');
    });

    it('should use "Sem assunto" when subject is missing', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
      };

      const result = parseRaw(parsed);
      expect(result.subject).toBe('Sem assunto');
    });

    it('should preserve full bodyHtml for ActivityWriter processing', () => {
      const longHtml = '<p>' + 'a'.repeat(250_000) + '</p>';
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
        subject: 'Test',
        html: longHtml,
      };

      const result = parseRaw(parsed);
      // bodyHtml is NOT truncated — ActivityWriter handles large bodies
      expect(result.bodyHtml.length).toBeGreaterThan(200_000);
    });

    it('should truncate bodyText to 10,000 chars', () => {
      const longText = 'a'.repeat(15_000);
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
        subject: 'Test',
        text: longText,
      };

      const result = parseRaw(parsed);
      expect(result.bodyText.length).toBeLessThanOrEqual(10_000);
    });

    it('should convert HTML to text when text is missing', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
        subject: 'Test',
        html: '<p>Hello <strong>World</strong></p><br><p>Second paragraph</p>',
      };

      const result = parseRaw(parsed);
      expect(result.bodyText).toContain('Hello');
      expect(result.bodyText).toContain('World');
      expect(result.bodyText).toContain('Second paragraph');
    });

    it('should include inline CID attachments for upload to timeline', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
        subject: 'Test',
        html: '<img src="cid:image001">',
        attachments: [
          {
            filename: 'image001.png',
            contentType: 'image/png',
            content: Buffer.from('png-data'),
            contentId: '<image001>',
            contentDisposition: 'inline',
          },
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('pdf-data'),
            contentDisposition: 'attachment',
          },
        ],
      };

      const result = parseRaw(parsed);
      // Both inline and regular attachments are included
      expect(result.attachments).toHaveLength(2);
      expect(result.attachments[0].fileName).toBe('report.pdf');
      expect(result.attachments[1].fileName).toBe('image001.png');
      expect(result.attachmentCount).toBe(2);
      // HTML keeps CID reference (ActivityWriter resolves it)
      expect(result.bodyHtml).toContain('cid:image001');
      // inlineImages should have the CID image data
      expect(result.inlineImages).toHaveLength(1);
      expect(result.inlineImages[0].cid).toBe('image001');
    });

    it('should handle empty to and cc fields', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
        subject: 'Test',
      };

      const result = parseRaw(parsed);
      expect(result.toEmails).toEqual([]);
      expect(result.ccEmails).toEqual([]);
    });

    it('should use current date when date is missing', () => {
      const before = new Date();
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'test@example.com', name: 'Test' }] },
        subject: 'Test',
      };

      const result = parseRaw(parsed);
      const after = new Date();
      expect(result.date.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.date.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should lowercase all email addresses', () => {
      const parsed = {
        messageId: '<test@example.com>',
        from: { value: [{ address: 'SENDER@EXAMPLE.COM', name: 'Sender' }] },
        to: { value: [{ address: 'TO@EXAMPLE.COM' }] },
        cc: { value: [{ address: 'CC@EXAMPLE.COM' }] },
        subject: 'Test',
      };

      const result = parseRaw(parsed);
      expect(result.fromEmail).toBe('sender@example.com');
      expect(result.toEmails).toEqual(['to@example.com']);
      expect(result.ccEmails).toEqual(['cc@example.com']);
    });
  });

  describe('cleanHtml', () => {
    it('should remove script tags', () => {
      const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
      const result = cleanHtml(html);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert');
      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });

    it('should remove style tags', () => {
      const html = '<style>body { color: red; }</style><p>Content</p>';
      const result = cleanHtml(html);
      expect(result).not.toContain('<style');
      expect(result).not.toContain('color: red');
      expect(result).toContain('Content');
    });

    it('should keep CID references in HTML (resolved by ActivityWriter)', () => {
      const html = '<img src="cid:image001">';
      const attachments = [
        {
          contentId: '<image001>',
          contentType: 'image/png',
          content: Buffer.from('png-data'),
        },
      ];

      const result = cleanHtml(html, attachments);
      // CID references are kept — ActivityWriter uploads and replaces with URLs
      expect(result).toContain('cid:image001');
    });

    it('should return empty string for null/undefined input', () => {
      expect(cleanHtml(null)).toBe('');
      expect(cleanHtml(undefined)).toBe('');
      expect(cleanHtml('')).toBe('');
    });
  });

  describe('htmlToText', () => {
    it('should strip HTML tags', () => {
      const html = '<p>Hello <strong>World</strong></p>';
      const result = htmlToText(html);
      expect(result).toContain('Hello');
      expect(result).toContain('World');
      expect(result).not.toContain('<');
    });

    it('should convert br to newlines', () => {
      const html = 'Line 1<br>Line 2<br/>Line 3';
      const result = htmlToText(html);
      expect(result).toContain('Line 1\nLine 2\nLine 3');
    });

    it('should convert p closing tags to double newlines', () => {
      const html = '<p>Para 1</p><p>Para 2</p>';
      const result = htmlToText(html);
      expect(result).toContain('Para 1');
      expect(result).toContain('Para 2');
    });

    it('should decode HTML entities', () => {
      const html = '&amp; &lt; &gt; &quot; &#39;';
      const result = htmlToText(html);
      expect(result).toBe('& < > " \'');
    });

    it('should return empty string for null/undefined input', () => {
      expect(htmlToText(null)).toBe('');
      expect(htmlToText(undefined)).toBe('');
      expect(htmlToText('')).toBe('');
    });
  });
});

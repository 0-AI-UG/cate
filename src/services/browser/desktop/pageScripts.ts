// Functions the page driver runs in a page (`Runtime.callFunctionOn`, as
// `this`), kept as source text.

/** Visible and enabled: a field a person could type into. */
const VISIBLE_FIELD = `(element) => {
  const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
  return !element.disabled && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}`
// Sign-in fields, called on an element (the agent's target) or the document.
export const PASSWORD_FIELD = `function () {
  const visible = ${VISIBLE_FIELD};
  if (this instanceof HTMLInputElement) return this.type.toLowerCase() === 'password' ? this : null;
  const fields = Array.from(this.querySelectorAll('input[type=password]')).filter(visible);
  return fields.find(field => field.autocomplete.toLowerCase() !== 'new-password') || fields[0] || null;
}`
/** The username field of a password field's form (`this`: the password field). */
export const USERNAME_FOR_PASSWORD = `function () {
  const visible = ${VISIBLE_FIELD};
  const scope = this.form || this.ownerDocument.body;
  return Array.from(scope.querySelectorAll('input[autocomplete="username"],input[autocomplete="email"],input[type="email"],input[type="text"]')).filter(visible).at(-1) || null;
}`
/** The username field of a sign-in step that asks for it alone. */
export const USERNAME_FIELD = `function () {
  const visible = ${VISIBLE_FIELD};
  const text = (field) => field instanceof HTMLInputElement && ['text', 'email', 'tel'].includes(field.type.toLowerCase());
  if (this instanceof HTMLInputElement) return text(this) ? this : null;
  const fields = Array.from(this.querySelectorAll('input')).filter(field => text(field) && visible(field));
  return fields.find(field => /username|email/.test(field.autocomplete.toLowerCase()))
    || fields.find(field => field.type.toLowerCase() === 'email')
    || fields.find(field => /user|login|email|account|identifier/i.test(field.name + ' ' + field.id))
    || (fields.length === 1 ? fields[0] : null);
}`
/** The file input an element stands for: itself, the input of its label, or
 *  the one input inside it (a styled button or drop area wrapping it). */
export const FILE_INPUT_OF = `function () {
  const isFile = (node) => node instanceof HTMLInputElement && node.type === 'file';
  const element = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
  if (!element) return null;
  if (isFile(element)) return element;
  const label = element instanceof HTMLLabelElement ? element : element.closest('label');
  if (label && isFile(label.control)) return label.control;
  const inside = element.querySelectorAll('input[type=file]');
  return inside.length === 1 ? inside[0] : null;
}`

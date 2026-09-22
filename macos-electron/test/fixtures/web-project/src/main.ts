import { message } from './message';
const heading = document.querySelector<HTMLHeadingElement>('#message')!;
heading.textContent = message;
// This identifier must survive the edit: a page reload is not HMR evidence.
document.body.dataset.documentId = crypto.randomUUID();
if (import.meta.hot) {
  import.meta.hot.accept('./message', module => {
    if (module) heading.textContent = module.message;
  });
}

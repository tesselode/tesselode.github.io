window.addEventListener('DOMContentLoaded', () => {
	for (const collapse of document.querySelectorAll('.collapse')) {
		let expanded = false;
		const header = collapse.querySelector('.collapse-header');
		const arrow = header.querySelector('i');
		const contentWrapper = collapse.querySelector('.collapse-content-wrapper');
		const content = contentWrapper.querySelector('.collapse-content');
		header.addEventListener('click', () => {
			expanded = !expanded;
			contentWrapper.style.maxHeight = expanded ? content.clientHeight + 'px' : '';
			arrow.style.transform = expanded ? 'rotate(180deg)' : 'rotate(0deg)';
		});
	}
});

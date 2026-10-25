(function (window, document) {
  'use strict';

  if (window.SPA && window.SPA.__initialized) return;

  var $ = window.jQuery;
  var registry = {};
  var loadedScripts = {};
  var activeModule = null;
  var activeUrl = window.location.pathname + window.location.search;
  var pendingRequest = null;
  var contentSelector = '#content-wrapper';

  function getModuleName(url) {
    try {
      var parsed = new URL(url, window.location.origin);
      var firstSegment = parsed.pathname.split('/').filter(Boolean)[0] || 'home';
      return firstSegment;
    } catch (error) {
      return 'home';
    }
  }

  function isHtmlResponse(contentType) {
    var normalized = (contentType || '').toLowerCase();
    return normalized.includes('text/html') || normalized.includes('application/xhtml+xml') || normalized === '';
  }

  function tryParseJson(text) {
    if (typeof text !== 'string') return null;
    var trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return null;
    }
  }

  function normalizeAjaxContent(responseText) {
    if (typeof responseText !== 'string') return null;

    var trimmed = responseText.trim();
    if (!trimmed) return null;

    if (tryParseJson(trimmed)) return null;

    if (/<html[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed)) {
      try {
        var parsed = new DOMParser().parseFromString(trimmed, 'text/html');
        var extracted = parsed.querySelector(contentSelector);
        if (extracted && extracted.innerHTML && extracted.innerHTML.trim()) {
          return extracted.innerHTML;
        }
        return null;
      } catch (error) {
        console.error('Gagal parse full HTML response:', error);
        return null;
      }
    }

    if (!/<[a-z][\s\S]*>/i.test(trimmed)) return null;
    return trimmed;
  }

  function extractScripts(container) {
    var scripts = Array.prototype.slice.call(container.querySelectorAll('script'));
    scripts.forEach(function (script) {
      if (script.parentNode) script.parentNode.removeChild(script);
    });
    return scripts;
  }

  function executeScripts(scripts) {
    scripts.forEach(function (sourceScript) {
      var src = sourceScript.getAttribute('src');
      var type = sourceScript.getAttribute('type') || 'text/javascript';

      if (src) {
        var absoluteSrc = new URL(src, window.location.origin).href;
        if (loadedScripts[absoluteSrc] || isScriptLoaded(absoluteSrc)) {
          loadedScripts[absoluteSrc] = true;
          return;
        }

        var externalScript = document.createElement('script');
        externalScript.src = absoluteSrc;
        externalScript.type = type;
        externalScript.async = false;
        externalScript.setAttribute('data-spa-loaded', '1');
        loadedScripts[absoluteSrc] = true;
        document.body.appendChild(externalScript);
        return;
      }

      if ((sourceScript.textContent || '').trim()) {
        var inlineScript = document.createElement('script');
        inlineScript.type = type;
        inlineScript.setAttribute('data-spa-inline', '1');
        inlineScript.textContent = sourceScript.textContent;
        document.body.appendChild(inlineScript);
        document.body.removeChild(inlineScript);
      }
    });
  }

  function isScriptLoaded(absoluteSrc) {
    return Array.prototype.some.call(document.querySelectorAll('script[src]'), function (script) {
      try {
        return new URL(script.getAttribute('src'), window.location.origin).href === absoluteSrc;
      } catch (error) {
        return false;
      }
    });
  }

  function setContent(html, callback) {
    var done = typeof callback === 'function' ? callback : function () {};
    var wrapper = document.querySelector(contentSelector);

    if (!wrapper) {
      done();
      return;
    }

    wrapper.classList.add('fade-out');
    window.setTimeout(function () {
      wrapper.innerHTML = html;
      wrapper.classList.remove('fade-out');
      done();
    }, 200);
  }

  function normalizeUnitFilterState() {
    if (!$) return;

    var $wrapper = $(contentSelector);
    var $unit = $wrapper.find('#filterUnit').first();
    if (!$unit.length) return;

    var unitValue = $unit.val();
    if (!unitValue) return;

    var lastValue = $unit.data('spa-unit-normalized-value');
    var count = Number($unit.data('spa-unit-normalized-count') || 0);

    if (String(lastValue || '') !== String(unitValue)) {
      count = 0;
      $unit.data('spa-unit-normalized-value', unitValue);
    }

    if (count >= 4) return;
    $unit.data('spa-unit-normalized-count', count + 1);

    if ($unit.hasClass('select2-hidden-accessible')) {
      $unit.trigger('change.select2');
    }

    var $tahun = $wrapper.find('#filterTahun').first();
    if ($tahun.length && $tahun.val()) {
      $unit.trigger('change');
    }
  }

  function scheduleUnitFilterNormalization() {
    normalizeUnitFilterState();
    [0, 100, 350, 800, 1500].forEach(function (delay) {
      window.setTimeout(normalizeUnitFilterState, delay);
    });
  }

  function renderContent(html) {
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var scripts = extractScripts(temp);
    var cleanHtml = temp.innerHTML;

    setContent(cleanHtml, function () {
      executeScripts(scripts);
      initActiveModule(activeUrl);
      scheduleUnitFilterNormalization();
      updateNavbarBreadcrumb();
      dispatchLifecycleEvent('spa:content-loaded', { url: activeUrl, module: activeModule });
      if ($) $(document).trigger('contentLoaded', [activeUrl]);
    });
  }

  function destroyPluginInstances() {
    if (!$) return;
    var $wrapper = $(contentSelector);

    $('.select2-container--open').each(function () {
      var $container = $(this);
      if ($container.closest(contentSelector).length === 0) {
        $container.remove();
      }
    });

    $wrapper.find('.modal.show').each(function () {
      var modal = window.bootstrap && window.bootstrap.Modal ? window.bootstrap.Modal.getInstance(this) : null;
      if (modal) modal.hide();
    });

    if ($.fn.DataTable) {
      $wrapper.find('table.dataTable').each(function () {
        if ($.fn.DataTable.isDataTable(this)) {
          $(this).DataTable().destroy(true);
        }
      });
    }

    if ($.fn.select2) {
      $wrapper.find('select.select2-hidden-accessible').each(function () {
        try {
          $(this).select2('close');
          $(this).select2('destroy');
        } catch (error) {
          console.warn('Gagal destroy Select2:', error.message);
        }
      });
    }

    $('body > .select2-container--open, body > .select2-dropdown, body > .select2-results').remove();

    $wrapper.find('.flatpickr-input').each(function () {
      if (this._flatpickr) this._flatpickr.destroy();
    });
  }

  function dispatchLifecycleEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  }

  function destroyActiveModule() {
    dispatchLifecycleEvent('spa:before-unload', { url: activeUrl, module: activeModule });

    if (activeModule && registry[activeModule] && typeof registry[activeModule].destroy === 'function') {
      try {
        registry[activeModule].destroy();
      } catch (error) {
        console.error('Error destroying module ' + activeModule + ':', error);
      }
    }

    destroyPluginInstances();
  }

  function initActiveModule(url) {
    activeModule = getModuleName(url);
    if (registry[activeModule] && typeof registry[activeModule].init === 'function') {
      try {
        registry[activeModule].init({ url: url, root: document.querySelector(contentSelector) });
      } catch (error) {
        console.error('Error initializing module ' + activeModule + ':', error);
      }
    }
  }

  function showLoading(url) {
    var pageType = window.detectPageType ? window.detectPageType(url) : 'table';
    if (window.showPageSkeleton) {
      window.showPageSkeleton(pageType);
    } else if ($) {
      $(contentSelector).html('<div class="d-flex justify-content-center align-items-center" style="height:300px;"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>');
    }
  }

  function renderError(title, message, status) {
    var badge = status ? '<span class="badge bg-label-secondary mb-3">HTTP ' + status + '</span>' : '';
    var html = [
      '<div class="d-flex flex-column justify-content-center align-items-center text-center" style="min-height:400px;padding:3rem;">',
      '<div class="mb-3"><i class="bx bx-error-circle text-warning" style="font-size:4rem;"></i></div>',
      badge,
      '<h4 class="mb-2">' + escapeHtml(title) + '</h4>',
      '<p class="text-muted mb-0" style="max-width:520px;">' + escapeHtml(message) + '</p>',
      '</div>',
    ].join('');

    if ($) $(contentSelector).html(html);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function shouldHandleAsSpa(anchor) {
    var href = anchor.getAttribute('href');
    if (!href || href === '#' || href.startsWith('javascript:')) return false;
    if (anchor.target && anchor.target !== '_self') return false;
    if (anchor.hasAttribute('download') || anchor.dataset.spa === 'false') return false;

    var url;
    try {
      url = new URL(href, window.location.origin);
    } catch (error) {
      return false;
    }

    if (url.origin !== window.location.origin) return false;
    if (/\.(pdf|xlsx?|csv|docx?|zip|rar|png|jpe?g|gif|webp)$/i.test(url.pathname)) return false;
    if (/(download|export|print|preview|renderReport|sendReport)/i.test(url.pathname)) return false;
    return true;
  }

  function updateActiveMenu() {
    if (!$) return;
    var currentPath = window.location.pathname;
    $('#layout-menu .menu-item').removeClass('active open');

    var activeLink = $('#layout-menu a.menu-link').filter(function () {
      try {
        return new URL(this.getAttribute('href'), window.location.origin).pathname === currentPath;
      } catch (error) {
        return false;
      }
    }).first();

    if (activeLink.length) {
      activeLink.closest('.menu-item').addClass('active');
      activeLink.parents('.menu-sub').each(function () {
        $(this).closest('.menu-item').addClass('active open');
      });
    }
  }

  function updateNavbarBreadcrumb() {
    if (!$) return;
    var navbarBreadcrumb = $('.navbar-nav .breadcrumb');
    if (navbarBreadcrumb.length === 0) return;

    var contentBreadcrumb = $(contentSelector + ' h5.breadcrumb-style1').first();
    if (contentBreadcrumb.length > 0) {
      var parts = contentBreadcrumb.text().trim().split('/').map(function (text) { return text.trim(); });
      var subtitle = parts.length > 1 ? parts[0] : '';
      var title = parts.length > 1 ? parts[1] : parts[0];

      navbarBreadcrumb.empty();
      if (subtitle) {
        navbarBreadcrumb.append($('<li>').addClass('breadcrumb-item').append($('<a>').attr('href', 'javascript:void(0);').text(subtitle)));
      }
      navbarBreadcrumb.append($('<li>').addClass('breadcrumb-item active').text(title));
      contentBreadcrumb.hide();
      return;
    }

    var activeMenuItem = $('#layout-menu .menu-item.active').last();
    if (activeMenuItem.length === 0) return;

    var items = [];
    activeMenuItem.parents('.menu-item').each(function () {
      var link = $(this).children('a.menu-link').first();
      var text = link.children('div').first().text().trim() || link.text().trim();
      if (text) items.unshift(text);
    });

    var activeLink = activeMenuItem.children('a.menu-link').first();
    var activeText = activeLink.children('div').first().text().trim() || activeLink.text().trim();
    if (activeText) items.push(activeText);

    if (items.length) {
      navbarBreadcrumb.empty();
      items.forEach(function (item, index) {
        navbarBreadcrumb.append($('<li>').addClass(index < items.length - 1 ? 'breadcrumb-item text-muted' : 'breadcrumb-item active').text(item));
      });
    }
  }

  function handleStructuredResponse(data, url) {
    if (data && data.redirect) {
      window.location.href = data.redirect;
      return true;
    }
    if (data && data.message) {
      renderError(data.success === false ? 'Gagal memuat halaman' : 'Informasi', data.message);
      return true;
    }
    window.location.href = url;
    return true;
  }

  function loadContent(url, options) {
    var settings = Object.assign({ pushState: true }, options || {});
    var targetUrl = new URL(url, window.location.origin).pathname + new URL(url, window.location.origin).search;

    if (pendingRequest && typeof pendingRequest.abort === 'function') {
      pendingRequest.abort();
    }

    destroyActiveModule();
    activeUrl = targetUrl;
    showLoading(targetUrl);

    pendingRequest = $.ajax({
      url: targetUrl,
      type: 'GET',
      dataType: 'text',
      timeout: 30000,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      success: function (response, textStatus, jqXHR) {
        pendingRequest = null;
        var contentType = jqXHR.getResponseHeader('content-type') || '';
        var structured = tryParseJson(response);

        if (structured) {
          handleStructuredResponse(structured, targetUrl);
          return;
        }

        var normalizedContent = normalizeAjaxContent(response);
        if (!normalizedContent || !isHtmlResponse(contentType)) {
          window.location.href = targetUrl;
          return;
        }

        if (settings.pushState) history.pushState({ path: targetUrl }, '', targetUrl);
        renderContent(normalizedContent);
        updateActiveMenu();
      },
      error: function (jqXHR, textStatus) {
        pendingRequest = null;
        if (textStatus === 'abort') return;

        var structured = tryParseJson(jqXHR.responseText || '');
        if (structured && handleStructuredResponse(structured, targetUrl)) return;

        if (jqXHR.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (jqXHR.status === 403) {
          renderError('Akses ditolak', 'Anda tidak memiliki akses ke halaman ini.', 403);
          return;
        }
        if (jqXHR.status === 0) {
          renderError('Koneksi bermasalah', 'Tidak dapat menghubungi server. Periksa koneksi atau coba lagi.', 0);
          return;
        }

        renderError('Gagal memuat halaman', jqXHR.responseText || 'Terjadi kesalahan saat memuat halaman.', jqXHR.status);
      },
    });
  }

  function bindNavigation() {
    if (!$) return;

    $(document)
      .off('click.spa', '#layout-menu a.menu-link:not(.menu-toggle), #content-wrapper a[data-spa-link="true"]')
      .on('click.spa', '#layout-menu a.menu-link:not(.menu-toggle), #content-wrapper a[data-spa-link="true"]', function (event) {
        if (!shouldHandleAsSpa(this)) return;
        event.preventDefault();
        loadContent(this.href, { pushState: true });
      });

    window.onpopstate = function () {
      loadContent(window.location.pathname + window.location.search, { pushState: false });
    };
  }

  function register(moduleName, lifecycle) {
    if (!moduleName || !lifecycle) return;
    registry[moduleName] = lifecycle;
  }

  function boot() {
    if (!$) {
      console.error('jQuery tidak dimuat. SPA core tidak berjalan.');
      return;
    }

    bindNavigation();
    activeModule = getModuleName(activeUrl);
    initActiveModule(activeUrl);
    scheduleUnitFilterNormalization();
    updateActiveMenu();
    updateNavbarBreadcrumb();
    dispatchLifecycleEvent('spa:ready', { url: activeUrl, module: activeModule });
  }

  window.SPA = {
    __initialized: true,
    register: register,
    load: loadContent,
    refresh: function () { loadContent(window.location.pathname + window.location.search, { pushState: false }); },
    updateActiveMenu: updateActiveMenu,
    updateNavbarBreadcrumb: updateNavbarBreadcrumb,
    normalizeUnitFilterState: normalizeUnitFilterState,
    getActiveModule: function () { return activeModule; },
    getActiveUrl: function () { return activeUrl; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window, document);

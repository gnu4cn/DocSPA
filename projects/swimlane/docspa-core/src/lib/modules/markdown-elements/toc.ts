import {
  Component, Input, OnInit, ViewEncapsulation,
  HostBinding, ElementRef, Renderer2, HostListener
} from '@angular/core';

import { flatMap, map, share } from 'rxjs/operators';
import unified from 'unified';
import markdown from 'remark-parse';
import toc from 'mdast-util-toc';
import visit from 'unist-util-visit';
import slug from 'remark-slug';
import rehypeStringify from 'rehype-stringify';
import remark2rehype from 'remark-rehype';
import raw from 'rehype-raw';

import { join, splitHash } from '../../shared/utils';
import { throttleable } from '../../shared/throttle';

import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { FetchService } from '../../services/fetch.service';
import { RouterService } from '../../services/router.service';
import { LocationService } from '../../services/location.service';
import { HooksService } from '../../services/hooks.service';

import { links, images } from '../../shared/links';
import frontmatter from 'remark-frontmatter';
import * as MDAST from 'mdast';

import VFILE from 'vfile';
import { VFile } from '../../../vendor';

export function coerceBooleanProperty(value: any): boolean {
  return value != null && `${value}` !== 'false';
}

function getFoldPosition(elem: any) {
  const docViewTop = 0;
  const docViewBottom = window.innerHeight;

  const rect = elem.getBoundingClientRect();
  const elemTop = rect.top;
  const elemBottom = rect.bottom;

  return {
    aboveFold: elemTop <= docViewTop,
    belowFold: elemBottom >= docViewBottom,
    inFold: (elemBottom <= docViewBottom) && (elemTop >= docViewTop)
  }
}

@Component({
  selector: 'docspa-toc', // tslint:disable-line
  template: ``,
  encapsulation: ViewEncapsulation.None
})
export class TOCComponent implements OnInit {
  static readonly is = 'md-toc';

  @Input()
  path: string;

  @Input()
  plugins = false;

  @Input()
  minDepth = 1;

  @Input()
  maxDepth = 6;

  @Input()
  tight = true;

  @Input('collapse-lists')
  set collapseLists(val: string | boolean) {
    this._collapseLists = coerceBooleanProperty(val);
  }
  get collapseLists() {
    return this._collapseLists;
  }

  @HostBinding('innerHTML')
  html: SafeHtml;

  /**
   * If the TOC is for the current page, update active links on scroll
   */
  @HostListener('window:scroll', [])
  @throttleable(120)
  onWindowScroll() {
    if (this.isCurrentPage && this.contentAnchors) {
      this.inScrollHashes = [];
      let lastAboveFold = null;
      for (let i = 0; i < this.contentAnchors.length; i++) {
        const a = this.contentAnchors[i];
        const hash = splitHash(a.getAttribute('href'))[1];
        const { aboveFold, inFold } = getFoldPosition(a);
        if (inFold) {
          this.inScrollHashes.push(hash);
        } else if (aboveFold) {
          lastAboveFold = hash;
        }
      }
      this.inScrollHashes.push(lastAboveFold);
      this.markLinks();
    }
  }

  private processor: any;
  private _lastPath: string;
  private _collapseLists: boolean = true;

  private contentAnchors: NodeListOf<Element>;
  private tocLinks: NodeListOf<Element>;
  private inScrollHashes: string[] = [];

  private get isCurrentPage() {
    return !this.path;
  }

  constructor(
    private fetchService: FetchService,
    private routerService: RouterService,
    private locationService: LocationService,
    private sanitizer: DomSanitizer,
    private hooks: HooksService,
    private elm: ElementRef,
    private renderer: Renderer2
  ) {

    const toToc = () => {
      return (tree: MDAST.Root) => {
        const result = toc(tree, { maxDepth: this.maxDepth, tight: this.tight });

        tree.children = [].concat(
          tree.children.slice(0, result.index),
          result.map || []
        );

        return visit(tree, 'paragraph', (node: any, index: number, parent: any) => {
          if (parent.children.length > 1) {
            node.data = node.data || {};
            node.data.hProperties = node.data.hProperties || {};
            node.data.hProperties.class = node.data.hProperties.class || [];
            node.data.hProperties.class.push('has-children');
          }
          return true;
        });
      };
    };

    const removeMinNodes = () => {
      return (tree: MDAST.Root) => {
        return visit(tree, 'heading', (node: MDAST.Heading, index: number, parent: any) => {
          if (node.depth < this.minDepth) {
            parent.children.splice(index, 1);
          }
          return true;
        });
      };
    };

    // TODO: use toc directly instead of passing through remark2rehype and rehypeStringify
    this.processor = unified()
      .use(markdown)
      .use(frontmatter)
      .use(slug)
      .use(removeMinNodes)
      .use(toToc)
      .use(links, locationService)
      .use(images, locationService)
      .use(remark2rehype, { allowDangerousHTML: true })
      .use(raw)
      .use(rehypeStringify);
  }

  ngOnInit() {
    this.hooks.doneEach.tap('main-content-loaded', (page: VFile) => {
      if (page.data.docspa.isPageContent) {
        // load or update after main content changes
        this.load();
      } else {
        // update links any DOM changes
        this.markLinks();
      }
    });
  }

  private load() {
    const page = this.path || this.routerService.contentPage;;

    // Not a page, clear
    if (typeof page !== 'string' || page.trim() === '') {
      this.html = '';
      this._lastPath = page;
      this.markLinks();
      return;
    }

    // TOC content hasn't changed,
    // But content might have,
    // refresh links
    if (page === this._lastPath) {
      this.markLinks();
      return;
    }

    // get new TOC content
    const vfile = this.locationService.pageToFile(page) as VFile;
    const fullpath = join(vfile.cwd, vfile.path);
    this.fetchService.get(fullpath)
      .pipe(
        flatMap(async resource => {
          vfile.contents = resource.contents;
          vfile.data = vfile.data || {};
          /* const err = */ await this.processor.process(vfile);
          return vfile;
        }),
      ).subscribe(_vfile => {
        this.html = this.sanitizer.bypassSecurityTrustHtml(_vfile.contents as string);
        this._lastPath = page;
        setTimeout(() => {
          this.hooks.doneEach.call(_vfile);
          // console.log(this.toc);
        }, 30);
      });
  }

  /**
   * Determines if a link is active:
   *    1) If the content is the current TOC page... and link in scroll region
   *    2) If the content is not the current TOC page... and link is active
   * @param a
   */
  private isLinkActive(a: Element) {
    if (this.isCurrentPage) {
      const href = a.getAttribute('href');
      const [, hash] = splitHash(href);
      return this.inScrollHashes.includes(hash);
    } else {
      // note: active class is set by routerLink
      return a.classList.contains('active');
    }
  }

  private updateTree(elem: Element, isActive: boolean) {
    const action = isActive ? 'addClass' : 'removeClass';
  
    let p = elem.parentNode;

    // walk up dom to set active class
    while (p && ['LI', 'UL', 'P'].includes(p.nodeName)) {
      this.renderer[action](p, 'active');
      p = p.parentNode;
    }
  }

  @throttleable(120)
  private markLinks() {
    if (!this.collapseLists) return;

    this.tocLinks = this.elm.nativeElement.getElementsByTagName('a');
    if (this.isCurrentPage) {
      const content = document.getElementById('content');
      this.contentAnchors = content ? content.querySelectorAll('h1[id] a, h2[id] a, h3[id] a, h4[id] a, h5[id] a') : null;
    }

    // clear
    for (let i = 0; i < this.tocLinks.length; i++) {
      this.updateTree(this.tocLinks[i], false);
    }

    // set
    for (let i = 0; i < this.tocLinks.length; i++) {
      const a = this.tocLinks[i];
      if (this.isLinkActive(a)) {
        this.updateTree(this.tocLinks[i], true);
      }
    }
  }
}

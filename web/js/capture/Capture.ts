import {CaptureOpts} from './CaptureOpts';
import {WebContents, WebRequest} from 'electron';
import {CaptureResult} from './CaptureResult';
import {Logger} from '../logger/Logger';
import {Preconditions} from '../Preconditions';
import {PendingWebRequestsListener} from '../webrequests/PendingWebRequestsListener';
import {DebugWebRequestsListener} from '../webrequests/DebugWebRequestsListener';
import {WebRequestReactor} from '../webrequests/WebRequestReactor';
import {WebContentsDriver, WebContentsDriverFactory} from './drivers/WebContentsDriver';
import {BrowserProfile} from './BrowserProfile';
import {Strings} from '../util/Strings';
import {Optional} from '../util/ts/Optional';
import {Functions} from '../util/Functions';
import {Promises} from '../util/Promises';
import {ContentCaptureExecutor} from './ContentCaptureExecutor';
import {ResolveablePromise} from '../util/ResolveablePromise';

const log = Logger.create();

/**
 * This is a hard coded delay to hold off capturing the content until the page
 * has finished executing all onLoad handlers. I need our own way to handle this
 * within the capture main process. Maybe I could add our own loader to the END
 * of the list and only run once our loader function finishes last.
 *
 * @type {number}
 */
const EXECUTE_CAPTURE_DELAY = 1500;

export class Capture {

    public readonly browserProfile: BrowserProfile;

    public readonly captureOpts: CaptureOpts;

    public readonly pendingWebRequestsListener: PendingWebRequestsListener;

    public readonly debugWebRequestsListener: DebugWebRequestsListener;

    public readonly webRequestReactors: WebRequestReactor[] = [];

    private result = new ResolveablePromise<CaptureResult>();

    private webContents?: WebContents;

    private driver?: WebContentsDriver;

    constructor(browserProfile: BrowserProfile,
                captureOpts: CaptureOpts = {amp: true}) {

        this.browserProfile = Preconditions.assertNotNull(browserProfile, "browser");
        this.captureOpts = captureOpts;

        this.pendingWebRequestsListener = new PendingWebRequestsListener();
        this.debugWebRequestsListener = new DebugWebRequestsListener();

        if (captureOpts.pendingWebRequestsCallback) {
            this.pendingWebRequestsListener.addEventListener(captureOpts.pendingWebRequestsCallback);
        }

    }

    public async start(): Promise<CaptureResult> {

        const driver = await WebContentsDriverFactory.create(this.browserProfile);

        this.driver = driver;

        this.webContents = await driver.getWebContents();

        this.driver!.addEventListener('close', () => {
            this.stop();
        });

        this.onWebRequest(this.webContents.session.webRequest);

        this.browserProfile.navigation.navigated.addEventListener(event => {

            const url = event.link;

            Preconditions.assertNotNull(url, "url");

            if ( Strings.empty(url)) {
                throw new Error("URL may not be empty");
            }

            this.loadURL(event.link)
                .catch(err => log.error("Could not load URL: " + event.link, err));

        });

        return this.result;

    }

    private async loadURL(url: string) {

        // wait until the main URL loads.
        const loadURLPromise = this.driver!.loadURL(url);

        // wait a minimum amount of time for the page to load so that we can
        // make sure that all static content has executed.
        // const minDelayPromise = Promises.waitFor(EXECUTE_CAPTURE_DELAY);

        await Promise.all([ loadURLPromise ]);

        // the page loaded now... capture the content.
        await this.handleLoad(url);

    }

    private async handleLoad(url: string) {

        // see if we first need to handle the page in any special manner.

        // FIXME: make this into some type of content handlers system
        // so that we can add one off extensions like reloading the a page
        // when AMP or other features are detected.  We could also do AMP
        // earlier I thin like on-dom-ready.
        //

        const ampURL = await this.getAmpURL();

        // TODO: if we end up handling multiple types of URLs in the future
        // we might want to build up a history to prevent endless loops or
        // just keep track of the redirect count.
        if (this.captureOpts.amp && ampURL && ampURL !== url) {

            log.info("Found AMP URL.  Redirecting then loading: " + ampURL);

            await this.loadURL(ampURL);
            return;

        }

        return await this.capture();

    }

    public stop() {

        this.webRequestReactors.forEach(webRequestReactor => {
            log.info("Stopping webRequestReactor...");
            webRequestReactor.stop();
            log.info("Stopping webRequestReactor...done");
        });

    }

    /**
     * Called when the onLoad handler is executed and we're ready to start the
     * capture.
     */
    public async capture() {

        log.debug("Awaiting captured");

        await this.browserProfile.navigation.captured.once();

        return this.executeContentCapture();

    }

    /**
     * See if the page has a rel=amphtml URL.
     *
     * @return {Promise<string>}
     */
    private async getAmpURL() {

        /** @RendererContext */
        function fetchAmpURL() {

            const link = <HTMLLinkElement> document.querySelector("link[rel='amphtml']");

            if (link) {
                return link.href;
            }

            return null;

        }

        return await this.webContents!.executeJavaScript(Functions.functionToScript(fetchAmpURL));

    }

    public async executeContentCapture() {

        const result = await ContentCaptureExecutor.execute(this.webContents!, this.driver!.browserProfile);

        if (this.browserProfile.destroy) {
            Optional.of(this.driver).when(driver => driver.destroy());
        }

        this.result.resolve(result);

    }

    /**
     * Called when we have a web request to listen to. Either the first one
     * or subsequent ones from iframes.
     *
     * @param webRequest
     */
    public onWebRequest(webRequest: WebRequest) {

        if (this.browserProfile.useReactor) {

            const webRequestReactor = new WebRequestReactor(webRequest);
            webRequestReactor.start();

            this.webRequestReactors.push(webRequestReactor);

            this.pendingWebRequestsListener.register(webRequestReactor);

        }

    }

}

export interface CaptureResultCallback {
    (captureResult: CaptureResult): void;
}

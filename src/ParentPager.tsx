import * as React from 'react';
import {
  StyleSheet,
  TextInput,
  Keyboard,
  I18nManager,
  InteractionManager,
} from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import Animated, { Easing } from 'react-native-reanimated';
import memoize from './memoize';

import {
  Layout,
  NavigationState,
  Route,
  Listener,
  PagerCommonProps,
  EventEmitterProps,
} from './types';

type Binary = 0 | 1;

export type Props<T extends Route> = PagerCommonProps & {
  onIndexChange: (index: number) => void;
  navigationState: NavigationState<T>;
  layout: Layout;
  // Clip unfocused views to improve memory usage
  // Don't enable this on iOS where this is buggy and views don't re-appear
  removeClippedSubviews?: boolean;
  children: (
    props: EventEmitterProps & {
      // Animated value which represents the state of current index
      // It can include fractional digits as it represents the intermediate value
      position: Animated.Node<number>;
      // Function to actually render the content of the pager
      // The parent component takes care of rendering
      render: (children: React.ReactNode) => React.ReactNode;
      // Callback to call when switching the tab
      // The tab switch animation is performed even if the index in state is unchanged
      jumpTo: (key: string) => void;
    }
  ) => React.ReactNode;
  gestureHandlerProps: React.ComponentProps<typeof PanGestureHandler>;
};

type ComponentState = {
  enabled: boolean;
  childPanGestureHandlerRefs: React.RefObject<PanGestureHandler>[];
  childIsSwiping: Animated.Node<Binary>;
  activeRouteHasChildPager: Animated.Node<Binary>;
  childPagerRouteKeys: string[];
  // childCanSwipeRight: Animated.Node<Binary>;
  // childCanSwipeLeft: Animated.Node<Binary>;
};

const {
  Clock,
  Value,
  onChange,
  and,
  or,
  abs,
  add,
  block,
  call,
  ceil,
  clockRunning,
  cond,
  debug,
  divide,
  eq,
  event,
  floor,
  greaterThan,
  lessThan,
  max,
  min,
  multiply,
  neq,
  not,
  round,
  set,
  spring,
  startClock,
  stopClock,
  sub,
  timing,
} = Animated;

// function debug(message: any, value: any) {
//   return block([
//     call([value], ([a]) => {
//       console.log(`ParentPager - ${message} ${a}`)
//     }),
//     value,
//   ]);
// }

export const PagerContext = React.createContext({});

const TRUE = 1;
const FALSE = 0;
const NOOP = 0;
const UNSET = -1;

const DIRECTION_LEFT = 1;
const DIRECTION_RIGHT = -1;

const SWIPE_DISTANCE_MINIMUM = 20;

const SWIPE_VELOCITY_IMPACT = 0.2;

const SPRING_CONFIG = {
  stiffness: 1000,
  damping: 500,
  mass: 3,
  overshootClamping: true,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

const SPRING_VELOCITY_SCALE = 1;

const TIMING_CONFIG = {
  duration: 200,
  easing: Easing.out(Easing.cubic),
};

export default class ParentPager<T extends Route> extends React.Component<
  Props<T>,
  ComponentState
  > {
  static defaultProps = {
    swipeVelocityImpact: SWIPE_VELOCITY_IMPACT,
    springVelocityScale: SPRING_VELOCITY_SCALE,
  };

  state = {
    enabled: true,
    childPanGestureHandlerRefs: [] as React.RefObject<PanGestureHandler>[],
    childPagerRouteKeys: [] as string[],
    // some defaults in case no child gets registered
    // childIsSwiping: new Value(FALSE),
    // childCanSwipeRight: new Value(FALSE),
    // childCanSwipeLeft: new Value(FALSE),
  };

  componentDidMount() {
    // console.log('ParentPager componentDidMount!!!!!')
    // Register this PanGestureHandler with the parent (if parent exists)
    // in order to coordinate gestures between handlers.
    if (this.context && this.context.addGestureHandlerRef) {
      this.context.addGestureHandlerRef(this.gestureHandlerRef);
    }

    // if (this.checkIfActiveRouteHasChildPagers(this.props.navigationState)) {
    //   // console.log('YES - active route DOES have child pagers');
    //   this.activeRouteHasChildPager.setValue(TRUE);
    // } else {
    //   console.log('NO - active route DOES NOT have child pagers');
    //   this.activeRouteHasChildPager.setValue(FALSE);
    // }
  }

  componentDidUpdate(prevProps: Props<T>) {
    const {
      navigationState,
      layout,
      swipeVelocityImpact,
      springVelocityScale,
      springConfig,
      timingConfig,
    } = this.props;
    const { index, routes } = navigationState;

    // console.log(
    //   'ParentPager componentDidUpdate - index:',
    //   index,
    //   'navigationState:',
    //   navigationState
    // );

    // if (index !== prevProps.navigationState.index) {
    //   // not sure if the "if component updates during swipe" is relevant
    //   if (this.checkIfActiveRouteHasChildPagers(navigationState)) {
    //     console.log('YES - active route DOES have child pagers');
    //     this.activeRouteHasChildPager.setValue(TRUE);
    //   } else {
    //     console.log('NO - active route DOES NOT have child pagers');
    //     this.activeRouteHasChildPager.setValue(FALSE);
    //   }
    // }

    if (
      // Check for index in state to avoid unintended transition if component updates during swipe
      (index !== prevProps.navigationState.index &&
        index !== this.currentIndexValue) ||
      // Check if the user updated the index correctly after an update
      (typeof this.pendingIndexValue === 'number' &&
        index !== this.pendingIndexValue)
    ) {
      // Index in user's state is different from the index being tracked
      this.jumpToIndex(index);
    }

    // Reset the pending index
    this.pendingIndexValue = undefined;

    // Update our mappings of animated nodes when props change
    if (prevProps.navigationState.routes.length !== routes.length) {
      this.routesLength.setValue(routes.length);
    }

    if (prevProps.layout.width !== layout.width) {
      this.progress.setValue(-index * layout.width);
      this.layoutWidth.setValue(layout.width);
    }

    if (prevProps.swipeVelocityImpact !== swipeVelocityImpact) {
      this.swipeVelocityImpact.setValue(
        swipeVelocityImpact !== undefined
          ? swipeVelocityImpact
          : SWIPE_VELOCITY_IMPACT
      );
    }

    if (prevProps.springVelocityScale !== springVelocityScale) {
      this.springVelocityScale.setValue(
        springVelocityScale !== undefined
          ? springVelocityScale
          : SPRING_VELOCITY_SCALE
      );
    }

    if (prevProps.springConfig !== springConfig) {
      this.springConfig.damping.setValue(
        springConfig.damping !== undefined
          ? springConfig.damping
          : SPRING_CONFIG.damping
      );

      this.springConfig.mass.setValue(
        springConfig.mass !== undefined ? springConfig.mass : SPRING_CONFIG.mass
      );

      this.springConfig.stiffness.setValue(
        springConfig.stiffness !== undefined
          ? springConfig.stiffness
          : SPRING_CONFIG.stiffness
      );

      this.springConfig.restSpeedThreshold.setValue(
        springConfig.restSpeedThreshold !== undefined
          ? springConfig.restSpeedThreshold
          : SPRING_CONFIG.restSpeedThreshold
      );

      this.springConfig.restDisplacementThreshold.setValue(
        springConfig.restDisplacementThreshold !== undefined
          ? springConfig.restDisplacementThreshold
          : SPRING_CONFIG.restDisplacementThreshold
      );
    }

    if (prevProps.timingConfig !== timingConfig) {
      this.timingConfig.duration.setValue(
        timingConfig.duration !== undefined
          ? timingConfig.duration
          : TIMING_CONFIG.duration
      );
    }
  }

  componentWillUnmount() {
    if (this.interactionHandle !== null) {
      InteractionManager.clearInteractionHandle(this.interactionHandle);
    }
  }

  static contextType = PagerContext;

  // PanGestureHandler ref used for coordination with parent handlers
  private gestureHandlerRef: React.RefObject<
    PanGestureHandler
    > = React.createRef();

  private childGestureState = new Value(State.UNDETERMINED);
  private childCanSwipeRight = new Value(FALSE);
  private childCanSwipeLeft = new Value(FALSE);
  private activeRouteHasChildPager = new Value(FALSE);

  // Mechanism to add child PanGestureHandler refs in the case that this
  // Pager is a parent to child Pagers. Allows for coordination between handlers
  private providerVal = {
    addGestureHandlerRef: (ref: React.RefObject<PanGestureHandler>) => {
      if (!this.state.childPanGestureHandlerRefs.includes(ref)) {
        this.setState((prevState: ComponentState) => ({
          childPanGestureHandlerRefs: [
            ...prevState.childPanGestureHandlerRefs,
            ref,
          ],
        }));
      }
    },
    // registerChild: (isSwiping: any, canSwipeRight: any, canSwipeLeft: any) => {
    //   console.debug('register child:', isSwiping, canSwipeRight, canSwipeLeft)
    //
    //   this.setState({
    //     childIsSwiping: isSwiping,
    //     childCanSwipeRight: canSwipeRight,
    //     childCanSwipeLeft: canSwipeLeft,
    //   });
    // },
    /*
    registerChildPagerRouteKey: (key: string) => {
      if (!this.state.childPagerRouteKeys.includes(key)) {
        console.log('ParentPager - registerChildPagerRouteKey - adding key:', key);
        this.setState((prevState: ComponentState) => ({
          childPagerRouteKeys: [
            ...prevState.childPagerRouteKeys,
            key,
          ],
        }));
      }
    },*/
    setChildCanSwipeLeft: (value: any) => {
      this.childCanSwipeLeft.setValue(value);
      // this.activeRouteHasChildPager.setValue(TRUE);
      // console.log('ParentPager - childCanSwipeLeft.setValue', value)
    },
    setChildCanSwipeRight: (value: any) => {
      this.childCanSwipeRight.setValue(value);
      // console.log('ParentPager - childCanSwipeRight.setValue', value)
    },
    gestureHandlerRef: this.gestureHandlerRef,
    childGestureState: this.childGestureState,
  };


  // Clock used for tab transition animations
  private clock = new Clock();

  private gestureEventVelocityX = new Value(0);
  private gestureEventTranslationX = new Value(0);
  private gestureEventState = new Value(State.UNDETERMINED);

  // Tracks current state of gesture handler enabled
  private gesturesEnabled = new Value(1);
  private gestureEnded = new Value(0);
  private gestureIgnored = new Value(0);

  // private gestureIgnored = and(
  //   or(
  //     eq(this.gestureEventState, State.ACTIVE),
  //     // eq(this.gestureEventState, State.END),
  //   ),
  //   or(
  //     // only ignore gestures that a child is currently handling
  //     eq(this.childGestureState, State.BEGAN),
  //     eq(this.childGestureState, State.ACTIVE),
  //   ),
  //   or(
  //     and(greaterThan(this.gestureEventTranslationX, 0), this.childCanSwipeLeft),
  //     and(lessThan(this.gestureEventTranslationX, 0), this.childCanSwipeRight),
  //   )
  // );
  // private gestureX = new Value(0);
  // private velocityX = new Value(0);
  // private gestureState = new Value(State.UNDETERMINED);

  // private gestureX = cond(or(this.gestureIgnored, this.gestureEnded), 0, this.gestureEventTranslationX);
  // private velocityX = cond(or(this.gestureIgnored, this.gestureEnded), 0, this.gestureEventVelocityX);
  private gestureX = cond(or(this.gestureIgnored, this.gestureEnded), 0, this.gestureEventTranslationX);
  private velocityX = cond(or(this.gestureIgnored, this.gestureEnded), 0, this.gestureEventVelocityX);
  private gestureState = add(0, this.gestureEventState);


  private offsetX = new Value(0);



  // Current progress of the page (translateX value)
  private progress = new Value(
    // Initial value is based on the index and page width
    this.props.navigationState.index * this.props.layout.width * DIRECTION_RIGHT
  );

  // Initial index of the tabs
  private index = new Value(this.props.navigationState.index);

  // Next index of the tabs, updated for navigation from outside (tab press, state update)
  private nextIndex: Animated.Value<number> = new Value(UNSET);

  // Scene that was last entered
  private lastEnteredIndex = new Value(this.props.navigationState.index);

  // Whether the user is currently dragging the screen
  private isSwiping: Animated.Value<Binary> = new Value(FALSE);

  // Whether the update was due to swipe gesture
  // This controls whether the transition will use a spring or timing animation
  // Remember to set it before transition needs to occur
  private isSwipeGesture: Animated.Value<Binary> = new Value(FALSE);

  // Track the index value when a swipe gesture has ended
  // This lets us know if a gesture end triggered a tab switch or not
  private indexAtSwipeEnd: Animated.Value<number> = new Value(
    this.props.navigationState.index
  );

  // Mappings to some prop values
  // We use them in animation calculations, so we need live animated nodes
  private routesLength = new Value(this.props.navigationState.routes.length);
  private layoutWidth = new Value(this.props.layout.width);

  // Determines how relevant is a velocity while calculating next position while swiping
  private swipeVelocityImpact = new Value(
    this.props.swipeVelocityImpact !== undefined
      ? this.props.swipeVelocityImpact
      : SWIPE_VELOCITY_IMPACT
  );

  private springVelocityScale = new Value(
    this.props.springVelocityScale !== undefined
      ? this.props.springVelocityScale
      : SPRING_VELOCITY_SCALE
  );

  // The position value represent the position of the pager on a scale of 0 - routes.length-1
  // It is calculated based on the translate value and layout width
  // If we don't have the layout yet, we should return the current index
  private position = cond(
    this.layoutWidth,
    divide(multiply(this.progress, -1), this.layoutWidth),
    this.index
  );

  // Animation configuration
  private springConfig = {
    damping: new Value(
      this.props.springConfig.damping !== undefined
        ? this.props.springConfig.damping
        : SPRING_CONFIG.damping
    ),
    mass: new Value(
      this.props.springConfig.mass !== undefined
        ? this.props.springConfig.mass
        : SPRING_CONFIG.mass
    ),
    stiffness: new Value(
      this.props.springConfig.stiffness !== undefined
        ? this.props.springConfig.stiffness
        : SPRING_CONFIG.stiffness
    ),
    restSpeedThreshold: new Value(
      this.props.springConfig.restSpeedThreshold !== undefined
        ? this.props.springConfig.restSpeedThreshold
        : SPRING_CONFIG.restSpeedThreshold
    ),
    restDisplacementThreshold: new Value(
      this.props.springConfig.restDisplacementThreshold !== undefined
        ? this.props.springConfig.restDisplacementThreshold
        : SPRING_CONFIG.restDisplacementThreshold
    ),
  };

  private timingConfig = {
    duration: new Value(
      this.props.timingConfig.duration !== undefined
        ? this.props.timingConfig.duration
        : TIMING_CONFIG.duration
    ),
  };

  // The reason for using this value instead of simply passing `this._velocity`
  // into a spring animation is that we need to reverse it if we're using RTL mode.
  // Also, it's not possible to pass multiplied value there, because
  // value passed to STATE of spring (the first argument) has to be Animated.Value
  // and it's not allowed to pass other nodes there. The result of multiplying is not an
  // Animated.Value. So this value is being updated on each start of spring animation.
  private initialVelocityForSpring = new Value(0);

  // The current index change caused by the pager's animation
  // The pager is used as a controlled component
  // We need to keep track of the index to determine when to trigger animation
  // The state will change at various points, we should only respond when we are out of sync
  // This will ensure smoother animation and avoid weird glitches
  private currentIndexValue = this.props.navigationState.index;

  // The pending index value as result of state update caused by swipe gesture
  // We need to set it when state changes from inside this component
  // It also needs to be reset right after componentDidUpdate fires
  private pendingIndexValue: number | undefined = undefined;

  // Numeric id of the previously focused text input
  // When a gesture didn't change the tab, we can restore the focused input with this
  private previouslyFocusedTextInput: number | null = null;

  // Listeners for the entered screen
  private enterListeners: Listener[] = [];

  // InteractionHandle to handle tasks around animations
  private interactionHandle: number | null = null;

  /*
  private checkIfActiveRouteHasChildPagers = (
    navigationState: NavigationState<T>
  ): boolean => {
    const { routes, index, key } = navigationState;
    const { childPagerRouteKeys } = this.state;


    if (!childPagerRouteKeys.length) {
      console.log('checkIfActiveRouteHasChildPagers - no keys to check');
      return false;
    }

    console.log('checkIfActiveRouteHasChildPagers - state key:', key ,'looking for:', childPagerRouteKeys);
    if (childPagerRouteKeys.includes(key)) {
      console.log(`found key (${key}) in nav state`, childPagerRouteKeys);
      return true;
    } else {
      console.log(`nav key (${key}) does not match`, childPagerRouteKeys);
    }

    const activeRoute = routes[index];
    console.log('checkIfActiveRouteHasChildPagers - active key:', activeRoute.key ,'looking for:', childPagerRouteKeys, 'navigationState:', navigationState, 'activeRoute:', activeRoute);

    if (childPagerRouteKeys.includes(activeRoute.key)) {
      console.log('found activeRoute key in list of child pagers');
      return true;
    }

    if (!activeRoute.state) {
      console.log('active route has no children - no child pagers to find');
      return false;
    }

    return this.checkIfActiveRouteHasChildPagers(activeRoute.state)
  };
   */

  private jumpToIndex = (index: number) => {
    // If the index changed, we need to trigger a tab switch
    this.isSwipeGesture.setValue(FALSE);
    this.nextIndex.setValue(index);
  };

  private jumpTo = (key: string) => {
    const { navigationState, keyboardDismissMode, onIndexChange } = this.props;

    const index = navigationState.routes.findIndex(
      (route) => route.key === key
    );

    // A tab switch might occur when we're in the middle of a transition
    // In that case, the index might be same as before
    // So we conditionally make the pager to update the position
    if (navigationState.index === index) {
      this.jumpToIndex(index);
    } else {
      onIndexChange(index);

      // When the index changes, the focused input will no longer be in current tab
      // So we should dismiss the keyboard
      if (keyboardDismissMode === 'auto') {
        Keyboard.dismiss();
      }
    }
  };

  private addListener = (type: 'enter', listener: Listener) => {
    switch (type) {
      case 'enter':
        this.enterListeners.push(listener);
        break;
    }
  };

  private removeListener = (type: 'enter', listener: Listener) => {
    switch (type) {
      case 'enter': {
        const index = this.enterListeners.indexOf(listener);

        if (index > -1) {
          this.enterListeners.splice(index, 1);
        }

        break;
      }
    }
  };

  private handleEnteredIndexChange = ([value]: readonly number[]) => {
    const index = Math.max(
      0,
      Math.min(value, this.props.navigationState.routes.length - 1)
    );

    this.enterListeners.forEach((listener) => listener(index));
  };

  private transitionTo = (index: Animated.Node<number>) => {
    const toValue = new Value(0);
    const frameTime = new Value(0);

    const state = {
      position: this.progress,
      time: new Value(0),
      finished: new Value(FALSE),
    };

    // console.log('ParentPager - transitionTo', index)

    return block([
      cond(clockRunning(this.clock), NOOP, [
        // debug('transitionTo start', state.position),
        // Animation wasn't running before
        // Set the initial values and start the clock
        // debug('start animation', index),
        call([state.finished], () => {
          if (this.interactionHandle !== null) {
            // console.log('interaction handle already set??');
            InteractionManager.clearInteractionHandle(this.interactionHandle);
          }
          // console.log('animation started - create interaction handle');
          this.interactionHandle = InteractionManager.createInteractionHandle();
        }),
        set(toValue, multiply(index, this.layoutWidth, DIRECTION_RIGHT)),
        set(frameTime, 0),
        set(state.time, 0),
        set(state.finished, FALSE),
        set(this.index, index),
      ]),
      cond(
        this.isSwipeGesture,
        // Animate the values with a spring for swipe
        [
          // debug('transitionTo - isSwipeGesture', state.position),
          cond(
            not(clockRunning(this.clock)),
            I18nManager.isRTL
              ? set(
              this.initialVelocityForSpring,
              multiply(-1, this.velocityX, this.springVelocityScale)
              )
              : set(
              this.initialVelocityForSpring,
              multiply(this.velocityX, this.springVelocityScale)
              )
          ),
          spring(
            this.clock,
            { ...state, velocity: this.initialVelocityForSpring },
            { ...SPRING_CONFIG, ...this.springConfig, toValue }
          ),
        ],
        // Otherwise use a timing animation for faster switching
        [
          // debug('transitionTo not swipe gesture', state.position),
          timing(
            this.clock,
            { ...state, frameTime },
            { ...TIMING_CONFIG, ...this.timingConfig, toValue }
          )
        ]
      ),
      cond(not(clockRunning(this.clock)), [
        // debug('transitionTo start clock', state.position),
        startClock(this.clock)
      ]),
      cond(state.finished, [
        // debug('transitionTO finished', state.position),
        // Reset values
        set(this.isSwipeGesture, FALSE),
        // set(this.gestureX, 0),
        // set(this.velocityX, 0),
        set(this.gestureEventTranslationX, 0),
        set(this.gestureEventVelocityX, 0),

        call([state.finished], () => {
          if (this.interactionHandle !== null) {
            // console.log('animation ended - clear interaction handle');
            InteractionManager.clearInteractionHandle(this.interactionHandle);
            this.interactionHandle = null;
          } else {
            // console.log('animation ended but no interactionHandler found???');
          }
        }),
        // debug('animation ended', index),
        // When the animation finishes, stop the clock
        stopClock(this.clock),
      ]),
    ]);
  };

  private handleGestureEvent = event([
    {
      nativeEvent: {
        translationX: this.gestureEventTranslationX,
        velocityX: this.gestureEventVelocityX,
        state: this.gestureEventState,
      },
    },
  ]);

  // private handleGestureEvent = event([
  //   {
  //     nativeEvent: ({translationX, velocityX, state}) => block([
  //       set(this.gestureEventVelocityX, velocityX),
  //       set(this.gestureEventState, state),
  //       set(this.gestureEventTranslationX, translationX),
  //       debug('EVENT gestureEventState', this.gestureEventState),
  //       debug('EVENT gestureEventTranslationX', this.gestureEventTranslationX),
  //       debug('EVENT gestureEventVelocityX', this.gestureEventVelocityX),
  //       debug('EVENT childGestureState', this.childGestureState),
  //       debug('EVENT childCanSwipeLeft', this.childCanSwipeLeft),
  //       debug('EVENT childCanSwipeRight', this.childCanSwipeRight),
  //     ])
  //   },
  // ]);

  /*
  private handleGestureEvent2 = event([
    {
      nativeEvent: ({ translationX, velocityX, state }) => block([

        set(this.gestureEventState, state),
        set(this.gestureEventTranslationX, translationX),
        set(this.gestureEventVelocityX, velocityX),

        debug('EVENT gestureEventState', this.gestureEventState),
        debug('EVENT gestureEventTranslationX', this.gestureEventTranslationX),
        debug('EVENT gestureEventVelocityX', this.gestureEventVelocityX),
        debug('EVENT gestureIgnored', this.gestureIgnored),
        debug('EVENT gestureEnded', this.gestureEnded),
        debug('EVENT activeRouteHasChildPager', this.activeRouteHasChildPager),
        debug('EVENT childGestureState', this.childGestureState),
        // debug('EVENT childCanSwipeRight', this.childCanSwipeRight),
        // debug('EVENT childCanSwipeLeft', this.childCanSwipeLeft),

        cond(
          eq(this.gestureEventState, State.BEGAN),
          block([
            debug('BEGAN - NEW GESTURE - RESETTING', this.gestureEventState),
            set(this.gestureIgnored, FALSE),
            set(this.gestureEnded, FALSE),
            // set(this.gestureX, 0),
            // set(this.velocityX, 0),
          ])
        ),

        // ported
        cond(
          and(
            eq(this.gestureEventState, State.ACTIVE),
            not(this.gestureIgnored),
            or(
              // only ignore gestures that a child is currently handling
              eq(this.childGestureState, State.BEGAN),
              eq(this.childGestureState, State.ACTIVE),
            )
          ),
          block([
            cond(
              and(greaterThan(this.gestureEventTranslationX, 0), this.childCanSwipeLeft),
              block([
                debug('ignore left swipe gesture - child is swiping left', this.gestureEventTranslationX),
                set(this.gestureIgnored, TRUE),
              ])
            ),
            cond(
              and(lessThan(translationX, 0), this.childCanSwipeRight),
              block([
                debug('ignore right swipe gesture - child is swiping right', this.gestureEventTranslationX),
                set(this.gestureIgnored, TRUE),
              ])
            )
          ])
        ),

        // ported
        cond(
          // also filter out weird END repeat events on normal taps
          or(this.gestureIgnored, this.gestureEnded),
          block([
            set(this.velocityX, 0),
            set(this.gestureX, 0),
          ]),
          block([
            set(this.velocityX, velocityX),
            set(this.gestureX, translationX),
          ]),
        ),

        // ported
        set(this.gestureState, state),

        // perform this after above logic so that we still process first END event
        // but not the subsequent ghost ones
        cond(
          eq(this.gestureEventState, State.END),
          block([
            debug('END - GESTURE CLOSED RESETTING', this.gestureEventState),
            set(this.gestureIgnored, FALSE),
            set(this.gestureEnded, TRUE),
            // set(this.gestureX, 0),
            // set(this.velocityX, 0),
          ])
        ),

        debug('EXIT velocityX', this.velocityX),
        debug('EXIT gestureX', this.gestureX),
        debug('EXIT gestureState', this.gestureState),

        // cond(
        //   or(
        //     and(greaterThan(translationX, 0), this.childCanSwipeLeft),
        //     ,
        //   ),
        //   set(this.gestureIgnored, TRUE)
        // ),

        // cond(or(
        //   eq(state, State.UNDETERMINED),
        //   eq(state, State.BEGAN),
        //   eq(state, State.END),
        //   eq(state, State.FAILED),
        //   eq(state, State.CANCELLED),
        // ), block([
        //   debug('state is no longer active, resetting', this.gestureIgnored),
        //   set(this.gestureIgnored, 0)
        // ])),
        //
        // cond(
        //   or(
        //     and(greaterThan(translationX, 0), this.childCanSwipeLeft),
        //     and(lessThan(translationX, 0), this.childCanSwipeRight),
        //   ),
        //   set(this.gestureIgnored, TRUE)
        // ),
        // debug('this.gestureIgnored', this.gestureIgnored),
        //
        // cond(
        //   this.gestureIgnored,
        //   block([
        //     set(this.isSwipeGesture, FALSE),
        //     set(this.isSwiping, FALSE),
        //     set(this.gestureState, State.CANCELLED)
        //   ]),
        //   block([
        //     set(this.gestureX, translationX),
        //     set(this.velocityX, velocityX),
        //     set(this.gestureState, state)
        //   ])
        // )
      ])
    }
  ]);


        // debug('native event gestureX:', this.gestureX),
        // debug('native event translationX:', translationX),
        // debug('native event childCanSwipeRight:', this.childCanSwipeRight),
        // debug('native event childCanSwipeLeft:', this.childCanSwipeLeft),
        // cond(lessThan(translationX,0), debug('is swiping right?', this.gestureX)),
        // cond(greaterThan(translationX,0), debug('is swiping left?', this.gestureX)),
        // cond(
        //   and(greaterThan(translationX,0), not(this.childCanSwipeLeft)),
        //   block([
        //     debug('allow swipe left', this.gestureX),
        //     set(this.gestureX, translationX),
        //     set(this.velocityX, velocityX)
        //   ]),
        //   cond(
        //     and(lessThan(translationX,0), not(this.childCanSwipeRight)),
        //     block([
        //       debug('allow swipe right', this.gestureX),
        //       set(this.gestureX, translationX),
        //       set(this.velocityX, velocityX)
        //     ]),
        //     block([
        //       debug('KILL GESTURE dont allow swipe right', this.gestureX),
        //       set(this.gesturesEnabled, FALSE)
        //     ])
        //   ),
          // block([
          //   debug('dont allow swipe left', this.gestureX),
          //   set(this.gestureX, 0),
          //   set(this.velocityX, 0)
          // ])
        // ),

        // set(this.gestureX, translationX),
        // set(this.gestureState, state),
      // ])

      // nativeEvent: {
      //   translationX: this.gestureX,
      //   velocityX: this.velocityX,
      //   state: this.gestureState,
      // },
    // },
  // ]);
*/
  private extrapolatedPosition = add(
    this.gestureX,
    multiply(this.velocityX, this.swipeVelocityImpact)
  );

  private toggleEnabled = () => {
    if (this.state.enabled)
      this.setState({ enabled: false }, () => {
        this.setState({ enabled: true });
      });
  };

  // Cancel gesture if swiping back from the initial tab or forward from the last tab.
  // Enables parent Pager to pick up the gesture if one exists.
  private maybeCancel = block([
    // debug('maybeCancel gesturesEnabled', this.gesturesEnabled),
    cond(
      and(
        this.gesturesEnabled,
        or(
          and(
            eq(this.index, sub(this.routesLength, 1)),
            lessThan(this.gestureX, 0)
          ),
          and(eq(this.index, 0), greaterThan(this.gestureX, 0))
        )
      ),
      set(this.gesturesEnabled, 0)
    ),
  ]);


  private translateX = block([
    onChange(
      this.gestureEventState,
      block([
        cond(
          eq(this.gestureEventState, State.BEGAN),
          block([
            // debug(
            //   'gestureEventState changed to began. resetting',
            //   this.gestureEventState
            // ),
            set(this.gestureEnded, FALSE),
            set(this.gestureIgnored, FALSE),
          ])
        ),
        cond(
          and(
            eq(this.gestureEventState, State.ACTIVE),
            or(
              // only ignore gestures that a child is currently handling
              eq(this.childGestureState, State.BEGAN),
              eq(this.childGestureState, State.ACTIVE),
            )
          ),
          block([
            // debug(
            //   'gestureEventState changed to active w/ active child',
            //   this.gestureEventState
            // ),
            cond(
              or(
                and(greaterThan(this.gestureEventTranslationX, 0), this.childCanSwipeLeft),
                and(lessThan(this.gestureEventTranslationX, 0), this.childCanSwipeRight),
                // on android, the first "active" frame of gesture always has 0 translation, so also check velocity for direction
                and(greaterThan(this.gestureEventVelocityX, 0), this.childCanSwipeLeft),
                and(lessThan(this.gestureEventVelocityX, 0), this.childCanSwipeRight),
              ),
              [
                // debug('setting gesture ignored', this.gestureEventTranslationX),
                set(this.gestureIgnored, TRUE),
              ]
            )
          ])
        ),
        // cond(
        //   eq(this.gestureEventState, State.END),
        //   block([
        //     debug(
        //       'gestureEventState changed to end. resetting',
        //       this.gestureEventState
        //     ),
        //     set(this.gestureEnded, TRUE),
        //   ])
        // ),
      ])
    ),
    // onChange(
    //   this.childCanSwipeLeft,
    //   debug('childCanSwipeLeft changed', this.childCanSwipeLeft)
    // ),
    // onChange(
    //   this.childCanSwipeRight,
    //   debug('childCanSwipeRight changed', this.childCanSwipeRight)
    // ),
    // onChange(
    //   this.childGestureState,
    //   debug('childGestureState changed', this.childGestureState)
    // ),
    // onChange(
    //   this.gestureX,
    //   debug('gestureX', this.gestureX)
    // ),
    // onChange(
    //   this.gestureX,
    //   debug('gestureX changed', this.gestureX)
    // ),
    // onChange(
    //   this.velocityX,
    //   debug('velocityX changed', this.velocityX)
    // ),
    // onChange(
    //   this.gestureState,
    //   debug('gestureState changed', this.gestureState)
    // ),
    // onChange(
    //   this.gestureIgnored,
    //   debug('gesture ignored changed', this.gestureIgnored)
    // ),
    onChange(
      this.gesturesEnabled,
      cond(
        not(this.gesturesEnabled),
        call([this.gesturesEnabled], this.toggleEnabled)
      )
    ),
    onChange(
      this.index,
      call([this.index], ([value]) => {
        // console.log('ParentPager onChange(this.index)', value);
        this.currentIndexValue = value;
        // Without this check, the pager can go to an infinite update <-> animate loop for sync updates
        if (value !== this.props.navigationState.index) {
          // If the index changed, and previous animation has finished, update state
          this.props.onIndexChange(value);

          this.pendingIndexValue = value;

          // Force componentDidUpdate to fire, whether user does a setState or not
          // This allows us to detect when the user drops the update and revert back
          // It's necessary to make sure that the state stays in sync
          this.forceUpdate();
        }
      })
    ),
    onChange(
      this.position,
      // Listen to updates in the position to detect when we enter a screen
      // This is useful for things such as lazy loading when index change will fire too late
      cond(
        I18nManager.isRTL
          ? lessThan(this.gestureX, 0)
          : greaterThan(this.gestureX, 0),
        // Based on the direction of the gesture, determine if we're entering the previous or next screen
        cond(neq(floor(this.position), this.lastEnteredIndex), [
          set(this.lastEnteredIndex, floor(this.position)),
          call([floor(this.position)], this.handleEnteredIndexChange),
        ]),
        cond(neq(ceil(this.position), this.lastEnteredIndex), [
          set(this.lastEnteredIndex, ceil(this.position)),
          call([ceil(this.position)], this.handleEnteredIndexChange),
        ])
      )
    ),
    onChange(
      this.isSwiping,
      // Listen to updates for this value only when it changes
      // Without `onChange`, this will fire even if the value didn't change
      // We don't want to call the listeners if the value didn't change
      [
        cond(
          not(this.isSwiping),
          block([
            // debug('resetting', this.gestureIgnored),
            set(this.gesturesEnabled, 1),
            // set(this.gestureIgnored, 0),
          ])
        ),
        call(
          [this.isSwiping, this.indexAtSwipeEnd, this.index],
          ([isSwiping, indexAtSwipeEnd, currentIndex]: readonly number[]) => {
            // console.log('ParentPager - isSwiping changed - callback')
            const {
              keyboardDismissMode,
              onSwipeStart,
              onSwipeEnd,
            } = this.props;

            if (isSwiping === TRUE) {
              onSwipeStart?.();
              // this.interactionHandle = InteractionManager.createInteractionHandle();
              // console.log('used to create interaction handler here');

              if (keyboardDismissMode === 'auto') {
                const input = TextInput.State.currentlyFocusedField();

                // When a gesture begins, blur the currently focused input
                TextInput.State.blurTextInput(input);

                // Store the id of this input so we can refocus it if gesture was cancelled
                this.previouslyFocusedTextInput = input;
              } else if (keyboardDismissMode === 'on-drag') {
                Keyboard.dismiss();
              }
            } else {
              onSwipeEnd?.();

              // console.log('used to clear interaction handler here');
              // if (this.interactionHandle !== null) {
              //   InteractionManager.clearInteractionHandle(
              //     this.interactionHandle
              //   );
              // }

              if (keyboardDismissMode === 'auto') {
                if (indexAtSwipeEnd === currentIndex) {
                  // The index didn't change, we should restore the focus of text input
                  const input = this.previouslyFocusedTextInput;

                  if (input) {
                    TextInput.State.focusTextInput(input);
                  }
                }

                this.previouslyFocusedTextInput = null;
              }
            }
          }
        ),
      ]
    ),
    onChange(
      this.nextIndex,
      cond(neq(this.nextIndex, UNSET), [
        // Stop any running animations
        cond(clockRunning(this.clock), stopClock(this.clock)),
        // set(this.gestureX, 0),
        set(this.gestureEventTranslationX, 0),
        // Update the index to trigger the transition
        set(this.index, this.nextIndex),
        set(this.nextIndex, UNSET),
      ])
    ),
    cond(
      eq(this.gestureState, State.ACTIVE),
      [
        // this.maybeCancel,
        cond(this.isSwiping, NOOP, [
          // We weren't dragging before, set it to true
          set(this.isSwiping, TRUE),
          set(this.isSwipeGesture, TRUE),
          // Also update the drag offset to the last progress
          set(this.offsetX, this.progress),
        ]),
        // Update progress with previous offset + gesture distance
        set(
          this.progress,
          I18nManager.isRTL
            ? sub(this.offsetX, this.gestureX)
            : add(this.offsetX, this.gestureX)
        ),
        // Stop animations while we're dragging
        stopClock(this.clock),
      ],
      [
        set(this.isSwiping, FALSE),
        set(this.indexAtSwipeEnd, this.index),
        this.transitionTo(
          cond(
            and(
              // We should consider velocity and gesture distance only when a swipe ends
              // The gestureX value will be non-zero when swipe has happened
              // We check against a minimum distance instead of 0 because `activeOffsetX` doesn't seem to be respected on Android
              // For other factors such as state update, the velocity and gesture distance don't matter
              greaterThan(abs(this.gestureX), SWIPE_DISTANCE_MINIMUM),
              greaterThan(
                abs(this.extrapolatedPosition),
                divide(this.layoutWidth, 2)
              )
            ),
            // For swipe gesture, to calculate the index, determine direction and add to index
            // When the user swipes towards the left, we transition to the next tab
            // When the user swipes towards the right, we transition to the previous tab
            round(
              min(
                max(
                  0,
                  sub(
                    this.index,
                    cond(
                      greaterThan(this.extrapolatedPosition, 0),
                      I18nManager.isRTL ? DIRECTION_RIGHT : DIRECTION_LEFT,
                      I18nManager.isRTL ? DIRECTION_LEFT : DIRECTION_RIGHT
                    )
                  )
                ),
                sub(this.routesLength, 1)
              )
            ),
            // Index didn't change/changed due to state update
            this.index
          )
        ),
      ]
    ),
    onChange(
      this.gestureEventState,
      block([
        // cond(
        //   eq(this.gestureEventState, State.BEGAN),
        //   block([
        //     debug(
        //       'gestureEventState changed to began. resetting',
        //       this.gestureEventState
        //     ),
        //     set(this.gestureEnded, FALSE),
        //   ])
        // ),
        cond(
          eq(this.gestureEventState, State.END),
          block([
            // debug(
            //   'gestureEventState changed to end. resetting',
            //   this.gestureEventState
            // ),
            set(this.gestureEnded, TRUE),
          ])
        ),
      ])
    ),
    this.progress,
  ]);

  private getTranslateX = memoize(
    (
      layoutWidth: Animated.Node<number>,
      routesLength: Animated.Node<number>,
      translateX: Animated.Node<number>,
    ) =>
      multiply(
        // Make sure that the translation doesn't exceed the bounds to prevent overscrolling
        min(
          max(
            multiply(layoutWidth, sub(routesLength, 1), DIRECTION_RIGHT),
            translateX
          ),
          0
        ),
        I18nManager.isRTL ? -1 : 1
      )
  );

  render() {
    const {
      layout,
      navigationState,
      swipeEnabled,
      children,
      removeClippedSubviews,
      gestureHandlerProps,
    } = this.props;

    const translateX = this.getTranslateX(
      this.layoutWidth,
      this.routesLength,
      this.translateX
    );

    return children({
      position: this.position,
      addListener: this.addListener,
      removeListener: this.removeListener,
      jumpTo: this.jumpTo,
      render: (children) => (
        <PanGestureHandler
          ref={this.gestureHandlerRef}
          simultaneousHandlers={this.state.childPanGestureHandlerRefs}
          // waitFor={this.state.childPanGestureHandlerRefs}
          enabled={layout.width !== 0 && swipeEnabled && this.state.enabled}
          onGestureEvent={this.handleGestureEvent}
          onHandlerStateChange={this.handleGestureEvent}
          activeOffsetX={[-SWIPE_DISTANCE_MINIMUM, SWIPE_DISTANCE_MINIMUM]}
          failOffsetY={[-SWIPE_DISTANCE_MINIMUM*4, SWIPE_DISTANCE_MINIMUM*4]}
          {...gestureHandlerProps}
        >
          <Animated.View
            removeClippedSubviews={removeClippedSubviews}
            style={[
              styles.container,
              layout.width
                ? {
                  width: layout.width * navigationState.routes.length,
                  transform: [{ translateX }] as any,
                }
                : null,
            ]}
          >
            <PagerContext.Provider value={this.providerVal}>
              {children}
            </PagerContext.Provider>
          </Animated.View>
        </PanGestureHandler>
      ),
    });
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
  },
});

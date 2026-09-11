
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Logger } from '../services/logger';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        Logger.error('Uncaught React Error', error, { componentStack: errorInfo.componentStack });
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#212121' }}>
                    <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#FFC107', marginBottom: 12, textAlign: 'center' }}>
                        Something went wrong
                    </Text>
                    <Text style={{ fontSize: 14, color: '#F5F5F5', marginBottom: 24, textAlign: 'center' }}>
                        An unexpected error occurred. Please try again.
                    </Text>
                    <TouchableOpacity
                        onPress={this.handleReset}
                        style={{
                            backgroundColor: '#FFC107',
                            paddingHorizontal: 24,
                            paddingVertical: 12,
                            borderRadius: 8,
                        }}
                    >
                        <Text style={{ fontWeight: 'bold', color: '#212121', fontSize: 16 }}>Try Again</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        return this.props.children;
    }
}
